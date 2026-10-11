/**
 * Tool registry for the agent.
 *
 * Each tool has: an OpenAI-style JSON schema (used for native function calling),
 * an approval tier, and a handler. The same registry is rendered into the
 * system prompt so models without tool support can still drive the agent with
 * the JSON text protocol.
 */
import { runJavaScript, runPython, runShell, pythonStatus, summarizeExec } from './exec.js';
import { GitHubClient, clientFromStorage, readGitHubCredsAnywhere } from './github.js';
import { normPath, basename, truncate, isTextPath, formatBytes, prettyError } from './util.js';

export const APPROVAL = {
  READ: 'read',
  WRITE: 'write',
  EXEC: 'exec',
  GITHUB: 'github',
  PUBLISH: 'publish',
  NETWORK: 'network',
};

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function tool(name, description, parameters, approval, run) {
  return {
    name, description, approval, run,
    schema: { type: 'function', function: { name, description, parameters } },
  };
}

/* ═══════════════════════════════════════════════════════════
   Workspace tools
   ═══════════════════════════════════════════════════════════ */
const fsTools = [
  tool('list_files',
    'List every file and folder in the workspace as a tree. Use this first to orient yourself.',
    obj({ path: str('Optional sub-folder to list. Defaults to the workspace root.') }),
    APPROVAL.READ,
    async (ctx, args) => {
      const entries = await ctx.ws.list();
      const base = args.path ? normPath(args.path) : '';
      const rel = entries.filter((e) => !base || e.path === base || e.path.startsWith(base + '/'));
      if (!rel.length) return `(workspace is empty — nothing at ${base || '/'}). Create files with write_file.`;
      const lines = rel.slice(0, 500).map((e) => (e.type === 'dir' ? `${e.path}/` : `${e.path}  ${formatBytes(e.size || 0)}`));
      if (rel.length > 500) lines.push(`…and ${rel.length - 500} more`);
      return lines.join('\n');
    }),

  tool('read_file',
    'Read a text file from the workspace. Returns the raw content (optionally a line range).',
    obj({
      path: str('Workspace-relative file path, e.g. "src/app.js".'),
      start_line: num('Optional 1-based first line to return.'),
      end_line: num('Optional 1-based last line to return.'),
    }, ['path']),
    APPROVAL.READ,
    async (ctx, args) => {
      const p = normPath(args.path);
      if (!await ctx.ws.exists(p)) return `ERROR: no such file: ${p}. Use list_files to see what exists.`;
      if (!isTextPath(p)) {
        const st = await ctx.ws.stat(p);
        return `(binary file ${p}, ${formatBytes(st?.size || 0)} — cannot be shown as text)`;
      }
      const text = await ctx.ws.read(p);
      const lines = text.split('\n');
      const s = Math.max(1, args.start_line || 1);
      const e = Math.min(lines.length, args.end_line || lines.length);
      const slice = lines.slice(s - 1, e).join('\n');
      const meta = `── ${p} · ${lines.length} lines · ${formatBytes(text.length)} · showing ${s}-${e} ──\n`;
      return meta + truncate(slice, ctx.settings.maxFileCharsForModel, '\n…[file truncated — read a line range]');
    }),

  tool('write_file',
    'Create or overwrite a file in the workspace with the given content. Parent folders are created automatically. Always write the COMPLETE file — never a diff or placeholder.',
    obj({
      path: str('Workspace-relative path, e.g. "index.html".'),
      content: str('Full file content.'),
    }, ['path', 'content']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const p = normPath(args.path);
      if (!p) return 'ERROR: invalid path';
      const existed = await ctx.ws.exists(p);
      await ctx.ws.write(p, String(args.content ?? ''));
      const lines = String(args.content ?? '').split('\n').length;
      ctx.touch?.(p);
      return `${existed ? 'Updated' : 'Created'} ${p} (${lines} lines, ${formatBytes(String(args.content ?? '').length)})`;
    }),

  tool('edit_file',
    'Replace an exact string inside an existing file. old_string must match the file content character-for-character (include enough surrounding lines to be unique).',
    obj({
      path: str('Workspace-relative file path.'),
      old_string: str('Exact text to find. Must be unique unless replace_all is true.'),
      new_string: str('Replacement text.'),
      replace_all: bool('Replace every occurrence instead of only the first.'),
    }, ['path', 'old_string', 'new_string']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const p = normPath(args.path);
      if (!await ctx.ws.exists(p)) return `ERROR: no such file: ${p}`;
      const text = await ctx.ws.read(p);
      const oldS = String(args.old_string ?? '');
      if (!oldS) return 'ERROR: old_string is empty';
      const count = text.split(oldS).length - 1;
      if (count === 0) {
        const firstLine = oldS.split('\n')[0].trim().slice(0, 80);
        const near = text.split('\n').find((l) => firstLine && l.includes(firstLine.slice(0, 24)));
        return `ERROR: old_string not found in ${p}.${near ? `\nClosest line in file: ${near.trim().slice(0, 160)}` : ''}\nRead the file again and copy the exact text (whitespace matters).`;
      }
      if (count > 1 && !args.replace_all) {
        return `ERROR: old_string matches ${count} places in ${p}. Add more context to make it unique, or set replace_all=true.`;
      }
      const next = args.replace_all ? text.split(oldS).join(String(args.new_string ?? '')) : text.replace(oldS, String(args.new_string ?? ''));
      await ctx.ws.write(p, next);
      ctx.touch?.(p);
      return `Edited ${p}: replaced ${args.replace_all ? count : 1} occurrence(s).`;
    }),

  tool('delete_file',
    'Delete a file or folder (recursively) from the workspace.',
    obj({ path: str('Workspace-relative path to delete.') }, ['path']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const p = normPath(args.path);
      if (!p) return 'ERROR: refusing to delete the workspace root';
      if (!await ctx.ws.exists(p)) return `ERROR: no such path: ${p}`;
      await ctx.ws.remove(p);
      return `Deleted ${p}`;
    }),

  tool('make_directory', 'Create a directory (including parents).',
    obj({ path: str('Directory path, e.g. "src/components".') }, ['path']),
    APPROVAL.WRITE,
    async (ctx, args) => { await ctx.ws.mkdir(normPath(args.path)); return `Created directory ${normPath(args.path)}`; }),

  tool('rename_file', 'Move or rename a file or directory.',
    obj({ from: str('Current path.'), to: str('New path.') }, ['from', 'to']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const f = normPath(args.from), t = normPath(args.to);
      await ctx.ws.rename(f, t);
      return `Renamed ${f} → ${t}`;
    }),

  tool('search_files',
    'Search file contents (regex) across the workspace and return matching lines with file:line prefixes.',
    obj({
      pattern: str('Regular expression to search for.'),
      path: str('Optional folder or file to limit the search to.'),
      filename_pattern: str('Optional glob to filter file names, e.g. "*.js".'),
      case_insensitive: bool('Ignore case (default true).'),
    }, ['pattern']),
    APPROVAL.READ,
    async (ctx, args) => {
      const entries = (await ctx.ws.list()).filter((e) => e.type === 'file' && isTextPath(e.path));
      const base = args.path ? normPath(args.path) : '';
      const glob = args.filename_pattern ? new RegExp('^' + String(args.filename_pattern).replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
      let re;
      try { re = new RegExp(args.pattern, args.case_insensitive === false ? 'g' : 'gi'); }
      catch (e) { return `ERROR: invalid regex — ${prettyError(e)}`; }
      const hits = [];
      for (const e of entries) {
        if (base && !(e.path === base || e.path.startsWith(base + '/'))) continue;
        if (glob && !glob.test(basename(e.path))) continue;
        if ((e.size || 0) > 500_000) continue;
        let text;
        try { text = await ctx.ws.read(e.path); } catch { continue; }
        text.split('\n').forEach((line, i) => {
          re.lastIndex = 0;
          if (re.test(line) && hits.length < 200) hits.push(`${e.path}:${i + 1}: ${line.trim().slice(0, 220)}`);
        });
      }
      return hits.length ? `${hits.length} match(es):\n${hits.join('\n')}` : `No matches for /${args.pattern}/ in ${base || 'the workspace'}.`;
    }),
];

/* ═══════════════════════════════════════════════════════════
   Execution tools
   ═══════════════════════════════════════════════════════════ */
const execTools = [
  tool('run_shell',
    'Run a shell command against the workspace. Built-ins: ls, cd, pwd, cat, head, tail, wc, grep, find, mkdir, touch, rm, cp, mv, echo, tree, du, python, node. Pipes, &&, ||, ; and > redirects work.',
    obj({ command: str('Command line to execute, e.g. "ls -l src" or "grep -n TODO ." or "python build.py".') }, ['command']),
    APPROVAL.EXEC,
    async (ctx, args) => {
      const res = await runShell(String(args.command || ''), ctx.ws, {
        external: ctx.runtimes,
        onLog: (lvl, text) => ctx.onOutput?.(lvl, text),
      });
      const body = res.output || '(no output)';
      return `$ ${args.command}\n${truncate(body, ctx.settings.maxToolOutputChars)}\n[exit ${res.exitCode}${res.cwd ? ` · cwd ${res.cwd}` : ''}]`;
    }),

  tool('run_javascript',
    'Execute JavaScript in a sandboxed Web Worker. Available: console.*, an async fs API (fs.read, fs.write, fs.list, fs.exists, fs.remove, fs.mkdir), fetch, args, sleep. No DOM. Top-level await works.',
    obj({
      code: str('JavaScript source to run.'),
      timeout_ms: num('Kill the script after this many ms (default 20000).'),
    }, ['code']),
    APPROVAL.EXEC,
    async (ctx, args) => {
      const res = await runJavaScript(String(args.code || ''), ctx.ws, {
        timeoutMs: args.timeout_ms || ctx.settings.execTimeoutMs,
        onLog: (lvl, text) => ctx.onOutput?.(lvl, text),
      });
      return summarizeExec(res);
    }),

  tool('run_python',
    'Execute Python 3 in the browser via Pyodide (real CPython, WASM). The workspace is mounted read/write at the current directory, so open()/write() persist back into the project. Pure-Python and Pyodide packages (numpy, pandas, matplotlib…) are auto-installed on import. First call downloads the runtime (~10s).',
    obj({
      code: str('Python source to run.'),
      timeout_ms: num('Kill after this many ms (default 90000).'),
    }, ['code']),
    APPROVAL.EXEC,
    async (ctx, args) => {
      const st = pythonStatus();
      ctx.onOutput?.('info', st.state === 'ready' ? `python ${st.version}` : 'starting Pyodide runtime…');
      const res = await runPython(String(args.code || ''), ctx.ws, {
        timeoutMs: args.timeout_ms || 90000,
        onLog: (lvl, text) => ctx.onOutput?.(lvl, text),
        onStatus: (s) => ctx.onOutput?.('info', s),
        version: ctx.settings.pyodideVersion,
      });
      return summarizeExec(res);
    }),
];

/* ═══════════════════════════════════════════════════════════
   GitHub tools
   ═══════════════════════════════════════════════════════════ */
function gh(ctx) {
  const client = ctx.github || clientFromStorage();
  if (!client) {
    throw new Error('GitHub is not connected. Ask the user to open the GitHub tab and paste a Personal Access Token (classic token with "repo" scope). Never invent a token.');
  }
  return client;
}
const ghCreds = () => readGitHubCredsAnywhere() || {};

const githubTools = [
  tool('github_status',
    'Report whether GitHub is connected, which account, and the currently selected repository.',
    obj({}),
    APPROVAL.READ,
    async (ctx) => {
      const creds = ghCreds();
      if (!creds.token) return 'GitHub is NOT connected. The user must add a Personal Access Token in the GitHub tab before any github_* tool can be used.';
      try {
        const me = await gh(ctx).me();
        return JSON.stringify({
          connected: true, login: me.login, name: me.name, scopes: me.scopes,
          selectedRepo: ctx.settings.githubRepo || null, defaultBranch: ctx.settings.githubBranch,
          publicRepos: me.public_repos, privateRepos: me.private_repos,
        }, null, 2);
      } catch (e) { return `GitHub connected but the API rejected the token: ${prettyError(e)}`; }
    }),

  tool('github_list_repos',
    'List the user’s repositories (optionally filtered by a search string).',
    obj({ search: str('Optional substring to filter by name.'), limit: num('Max repos to return (default 30).') }),
    APPROVAL.READ,
    async (ctx, args) => {
      const repos = await gh(ctx).listRepos({ perPage: 100 });
      const q = (args.search || '').toLowerCase();
      const list = repos
        .filter((r) => !q || r.full_name.toLowerCase().includes(q))
        .slice(0, args.limit || 30)
        .map((r) => `${r.full_name}  [${r.private ? 'private' : 'public'}]  default:${r.default_branch}  ${r.description || ''}`);
      return list.length ? list.join('\n') : `No repositories matched${q ? ` "${args.search}"` : ''}.`;
    }),

  tool('github_create_repo',
    'Create a new GitHub repository under the signed-in account (or an organisation they belong to).',
    obj({
      name: str('Repository name, e.g. "snake-game".'),
      description: str('Short description.'),
      private: bool('true = private (default), false = public. Public is required for free github.io Pages.'),
      auto_init: bool('Initialise with a README (default true).'),
      organization: str('Optional organisation login to create the repo under.'),
    }, ['name']),
    APPROVAL.GITHUB,
    async (ctx, args) => {
      const repo = await gh(ctx).createRepo({
        name: args.name, description: args.description || '', isPrivate: args.private !== false,
        autoInit: args.auto_init !== false, owner: args.organization || null,
      });
      ctx.setRepo?.(repo.full_name);
      return `Created ${repo.full_name} (${repo.private ? 'private' : 'public'}) → ${repo.html_url}\nDefault branch: ${repo.default_branch}`;
    }),

  tool('github_push',
    'Commit workspace files to a GitHub repository and update the branch. Can create the repo first if it does not exist. This is how you publish a project.',
    obj({
      repo: str('Repository as "owner/name". Defaults to the repo selected in the GitHub tab.'),
      branch: str('Target branch (default: the repo default or "main").'),
      message: str('Commit message.'),
      files: { type: 'array', items: { type: 'string' }, description: 'Optional list of workspace paths to include (folders allowed). Omit to push the whole workspace.' },
      create_if_missing: bool('Create the repository if it does not exist (default true).'),
      private: bool('When creating, make it private (default false, because GitHub Pages needs a public repo on free plans).'),
      enable_pages: bool('After pushing, turn on GitHub Pages for this branch (default false).'),
    }, ['message']),
    APPROVAL.GITHUB,
    async (ctx, args) => {
      const client = gh(ctx);
      let full = args.repo || ctx.settings.githubRepo || ghCreds().repo || '';
      if (!full) {
        const me = await client.me();
        full = `${me.login}/${(args.name || 'playground-project')}`;
      }
      const [owner, repo] = full.split('/');
      if (!owner || !repo) return `ERROR: "${full}" is not a valid owner/repo`;

      // make sure the repo exists
      try { await client.getRepo(owner, repo); }
      catch (e) {
        if (e.status !== 404) throw e;
        if (args.create_if_missing === false) throw new Error(`Repository ${full} does not exist and create_if_missing is false.`);
        const created = await client.createRepo({ name: repo, description: 'Created from Puter Playground', isPrivate: args.private === true, autoInit: false, owner: null });
        ctx.setRepo?.(created.full_name);
      }

      const files = await GitHubClient.filesFromWorkspace(ctx.ws, {
        only: Array.isArray(args.files) && args.files.length ? args.files.map(normPath) : null,
        skip: [/^\.git\//, /node_modules\//],
      });
      if (!files.length) return 'ERROR: the workspace is empty — nothing to push. Write files first.';

      const repoInfo = await client.getRepo(owner, repo);
      const branch = args.branch || (repoInfo.default_branch && repoInfo.size > 0 ? repoInfo.default_branch : (ctx.settings.githubBranch || 'main'));

      ctx.onOutput?.('info', `pushing ${files.length} file(s) to ${full}@${branch}…`);
      const res = await client.pushFiles({
        owner, repo, branch, files,
        message: args.message || 'Update from Puter Playground',
        onProgress: (label, d, t) => ctx.onProgress?.(d / t, `${label} (${d}/${t})`),
      });

      let pagesNote = '';
      if (args.enable_pages) {
        try {
          const pages = await client.enablePages(owner, repo, { branch, path: '/' });
          pagesNote = `\nGitHub Pages: ${pages?.html_url || 'enabled'} (first build takes ~1 minute)`;
        } catch (e) { pagesNote = `\nGitHub Pages could not be enabled: ${prettyError(e)}`; }
      }
      ctx.setRepo?.(full);
      return `Pushed ${res.files} file(s) to ${full}@${branch}\ncommit ${res.sha.slice(0, 10)} → ${res.url}${pagesNote}`;
    }),

  tool('github_list_files', 'List files in a GitHub repository.',
    obj({ repo: str('"owner/name".'), ref: str('Branch, tag or commit (default: repo default branch).') }, ['repo']),
    APPROVAL.READ,
    async (ctx, args) => {
      const [owner, repo] = String(args.repo).split('/');
      const repoInfo = await gh(ctx).getRepo(owner, repo);
      const ref = args.ref || repoInfo.default_branch;
      const tree = await gh(ctx).listTree(owner, repo, ref);
      if (!tree.length) return `${args.repo}@${ref} is empty.`;
      return tree.filter((t) => t.type === 'blob').slice(0, 400).map((t) => `${t.path}  ${formatBytes(t.size || 0)}`).join('\n');
    }),

  tool('github_read_file', 'Read a file from a GitHub repository.',
    obj({ repo: str('"owner/name".'), path: str('File path in the repo.'), ref: str('Branch/tag/commit (optional).') }, ['repo', 'path']),
    APPROVAL.READ,
    async (ctx, args) => {
      const [owner, repo] = String(args.repo).split('/');
      const data = await gh(ctx).readFile(owner, repo, normPath(args.path), args.ref);
      if (data.encoding === 'base64') {
        return atob(String(data.content).replace(/\n/g, ''));
      }
      return data.content || JSON.stringify(data).slice(0, 2000);
    }),

  tool('github_create_branch', 'Create a new branch from an existing one.',
    obj({ repo: str('"owner/name".'), branch: str('New branch name.'), from: str('Source branch (default: repo default).') }, ['repo', 'branch']),
    APPROVAL.GITHUB,
    async (ctx, args) => {
      const [owner, repo] = String(args.repo).split('/');
      const info = await gh(ctx).getRepo(owner, repo);
      await gh(ctx).createBranch(owner, repo, args.branch, args.from || info.default_branch);
      return `Created branch ${args.branch} from ${args.from || info.default_branch} in ${args.repo}`;
    }),

  tool('github_open_pr', 'Open a pull request.',
    obj({ repo: str('"owner/name".'), title: str('PR title.'), body: str('PR description (markdown).'), head: str('Head branch.'), base: str('Base branch (default: repo default).') }, ['repo', 'title', 'head']),
    APPROVAL.GITHUB,
    async (ctx, args) => {
      const [owner, repo] = String(args.repo).split('/');
      const info = await gh(ctx).getRepo(owner, repo);
      const pr = await gh(ctx).createPullRequest(owner, repo, {
        title: args.title, body: args.body || '', head: args.head, base: args.base || info.default_branch,
      });
      return `Opened PR #${pr.number}: ${pr.html_url}`;
    }),

  tool('github_create_issue', 'Create an issue on a repository.',
    obj({ repo: str('"owner/name".'), title: str('Issue title.'), body: str('Issue body (markdown).'), labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels.' } }, ['repo', 'title']),
    APPROVAL.GITHUB,
    async (ctx, args) => {
      const [owner, repo] = String(args.repo).split('/');
      const issue = await gh(ctx).createIssue(owner, repo, { title: args.title, body: args.body || '', labels: args.labels || [] });
      return `Created issue #${issue.number}: ${issue.html_url}`;
    }),

  tool('github_enable_pages',
    'Turn on GitHub Pages for a repository so it is served at https://<user>.github.io/<repo>/. The repo must be public on a free GitHub plan.',
    obj({ repo: str('"owner/name".'), branch: str('Branch to publish (default "main").'), path: str('"/" for root or "/docs" (default "/").') }, ['repo']),
    APPROVAL.PUBLISH,
    async (ctx, args) => {
      const [owner, repo] = String(args.repo).split('/');
      const pages = await gh(ctx).enablePages(owner, repo, { branch: args.branch || 'main', path: args.path || '/' });
      return `GitHub Pages enabled → ${pages?.html_url || `https://${owner}.github.io/${repo}/`}\nStatus: ${pages?.status || 'building'} (first deploy takes about a minute).`;
    }),
];

/* ═══════════════════════════════════════════════════════════
   Puter extras
   ═══════════════════════════════════════════════════════════ */
const puterTools = [
  tool('deploy_to_puter',
    'Publish the workspace as a live static website on a free Puter subdomain (https://<subdomain>.puter.site). Requires the Puter cloud workspace or sign-in.',
    obj({
      subdomain: str('Desired subdomain, e.g. "my-snake-game".'),
      source_dir: str('Workspace folder to publish (default: the whole workspace).'),
    }, ['subdomain']),
    APPROVAL.PUBLISH,
    async (ctx, args) => {
      if (!window.puter?.hosting) throw new Error('Puter.js hosting is unavailable.');
      if (!window.puter.auth?.isSignedIn?.()) {
        try { await window.puter.auth.signIn(); } catch { throw new Error('Publishing needs a (free) Puter account — the sign-in window was cancelled.'); }
      }
      const sub = String(args.subdomain).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const dirName = `playground-sites/${sub}`;
      const puter = window.puter;
      await puter.fs.mkdir(dirName, { createMissingParents: true, overwrite: false, dedupeName: false }).catch(() => {});

      const entries = (await ctx.ws.list()).filter((e) => e.type === 'file' &&
        (!args.source_dir || e.path.startsWith(normPath(args.source_dir))));
      if (!entries.length) throw new Error('Nothing to publish — the workspace is empty.');
      for (const e of entries) {
        const rel = args.source_dir ? e.path.slice(normPath(args.source_dir).length + 1) : e.path;
        if (!rel) continue;
        const blob = await ctx.ws.readBlob(e.path);
        await puter.fs.write(`${dirName}/${rel}`, blob, { overwrite: true, dedupeName: false, createMissingParents: true });
      }
      try { await puter.hosting.create(sub, dirName); }
      catch (e) {
        if (!/exist/i.test(prettyError(e))) throw e;
        await puter.hosting.update(sub, dirName);
      }
      return `Published ${entries.length} file(s) → https://${sub}.puter.site\n(Puter dir: ~/${dirName})`;
    }),

  tool('generate_image',
    `Generate an image with Puter's image models and save it into the workspace. Supports image-to-image editing (reference_image), aspect ratios, quality tiers and a credit-free test_mode.`,
    obj({
      prompt: str('What to draw. Detailed, concrete prompts work best.'),
      path: str('Where to save it, e.g. "assets/hero.png" (default: media/image-<n>.png).'),
      model: str('Optional model id, e.g. "gpt-image-2", "gemini-3.1-flash-image", "grok-imagine-image-2.0", "@cf/black-forest-labs/flux-1-schnell".'),
      provider: str('Optional provider: openai | gemini | xai | cloudflare | replicate | together | byteplus.'),
      quality: str('Optional quality: low | medium | high | auto (OpenAI), or a size tier 512 | 1K | 2K | 4K (Gemini).'),
      aspect_ratio: str('Optional aspect ratio such as "1:1", "16:9", "9:16".'),
      width: num('Optional output width in pixels (with height).'),
      height: num('Optional output height in pixels (with width).'),
      negative_prompt: str('Optional: what to keep out of the image.'),
      reference_image: str('Optional workspace path of an existing image to edit or condition on (image-to-image).'),
      test_mode: bool('Return a free sample WITHOUT spending any credits. Use it to check a prompt first.'),
    }, ['prompt']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const { generateImage, workspaceFileToDataUrl } = await import('./media.js');
      const refPath = args.reference_image ? normPath(String(args.reference_image)) : '';
      const referenceImage = refPath ? await workspaceFileToDataUrl(ctx.ws, refPath) : undefined;
      ctx.onOutput?.('info', `Generating image${args.test_mode ? ' (free test sample)' : ''}…`);
      const media = await generateImage({
        prompt: args.prompt, model: args.model, provider: args.provider, quality: args.quality,
        aspectRatio: args.aspect_ratio, width: args.width, height: args.height,
        negativePrompt: args.negative_prompt, referenceImage, testMode: !!args.test_mode,
      });
      const path = normPath(args.path || `media/image-${Date.now().toString(36)}.${media.ext}`);
      await ctx.ws.write(path, media.blob);
      ctx.touch?.(path);
      ctx.onMedia?.({
        kind: 'image', path, url: media.url, model: media.model,
        prompt: String(args.prompt).slice(0, 200), testMode: media.testMode,
      });
      return `Generated ${media.testMode ? 'test-sample ' : ''}image → ${path} (${formatBytes(media.blob.size)}, model: ${media.model})`;
    }),

  tool('generate_video',
    `Generate a short video clip with Puter's video models (Together/Wan, BytePlus/Seedance) and save it into the workspace. Can be conditioned on a first frame, a last frame and reference images. This is slow — a clip can take a minute or two.`,
    obj({
      prompt: str('What should happen in the clip. Describe subject, motion, camera and style.'),
      path: str('Where to save it, e.g. "media/clip.mp4" (default: media/video-<n>.mp4).'),
      model: str('Optional model id, e.g. "togetherai:wan-ai/wan2.7-t2v", "seedance-2-5".'),
      provider: str('Optional driver: together-video-generation | byteplus-video-generation.'),
      seconds: num('Optional clip length in seconds; unsupported values fall back to the model default.'),
      size: str('Optional output size as "1280x720", or a tier such as "720p" (Seedance, Wan 2.7).'),
      first_frame: str('Optional workspace path of an image to use as the first frame (image-to-video).'),
      last_frame: str('Optional workspace path of an image to use as the last frame.'),
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional workspace paths of subject/style reference images (Seedance: up to 9 on 2.0, 30 on 2.5).' },
      negative_prompt: str('Optional: what to keep out of the clip.'),
      generate_audio: bool('Optional: generate a soundtrack on models that support audio (Seedance).'),
      fps: num('Optional frames per second (Together models).'),
      test_mode: bool('Return a free sample clip WITHOUT spending credits.'),
    }, ['prompt']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const { generateVideo, workspaceFileToDataUrl } = await import('./media.js');
      const toRef = async (p) => (p ? await workspaceFileToDataUrl(ctx.ws, normPath(String(p))) : undefined);
      const refs = Array.isArray(args.reference_images) && args.reference_images.length
        ? await Promise.all(args.reference_images.map(toRef))
        : undefined;
      ctx.onOutput?.('info', `Generating video${args.test_mode ? ' (free test sample)' : ''} — this can take a minute or two…`);
      ctx.onProgress?.(0.15, 'generating video…');
      const media = await generateVideo({
        prompt: args.prompt, model: args.model, provider: args.provider, seconds: args.seconds, size: args.size,
        firstFrame: await toRef(args.first_frame), lastFrame: await toRef(args.last_frame), referenceImages: refs,
        negativePrompt: args.negative_prompt, generateAudio: args.generate_audio, fps: args.fps,
        testMode: !!args.test_mode,
      });
      const path = normPath(args.path || `media/video-${Date.now().toString(36)}.${media.ext}`);
      await ctx.ws.write(path, media.blob);
      ctx.touch?.(path);
      ctx.onMedia?.({
        kind: 'video', path, url: media.url, model: media.model, seconds: media.seconds,
        prompt: String(args.prompt).slice(0, 200), testMode: media.testMode,
      });
      return `Generated ${media.testMode ? 'test-sample ' : ''}video → ${path} (${formatBytes(media.blob.size)}, model: ${media.model}${media.seconds ? `, ${media.seconds}s` : ''})`;
    }),

  /* ═══ long-term memory ═══ */
  tool('remember',
    'Save a durable fact to long-term memory so it is known in every future conversation: who the user is, their preferences, their environment, ongoing projects, standing decisions. Do NOT save task-specific details, file contents, or secrets (keys, tokens, passwords).',
    obj({
      text: str('One sentence, third person, self-contained: "The user prefers TypeScript over JavaScript."'),
      kind: str('One of: fact | preference | project | decision | person | note.'),
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional short kebab-case tags for retrieval, e.g. ["typescript","style"]' },
      pinned: bool('Optional: pin it so it is always injected into the prompt, not just when relevant.'),
    }, ['text']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const { addMemory } = await import('./memory.js');
      const { entry, deduped } = addMemory({
        text: args.text, kind: args.kind || 'note', tags: args.tags || [], pinned: !!args.pinned,
        source: 'agent', conv: ctx.convId || null,
      });
      ctx.onMemory?.();
      return `${deduped ? 'Updated the existing memory' : 'Remembered'} [${entry.kind}] ${entry.text}`;
    }),

  tool('recall',
    'Search long-term memory. Use it before answering anything about the user, their preferences, their projects or past decisions — and whenever the user says "you know", "as I said", "my usual", "remember when".',
    obj({
      query: str('What to look for, in the user\'s own words where possible.'),
      kind: str('Optional filter: fact | preference | project | decision | person | note.'),
      limit: num('Optional maximum number of results (default 6).'),
    }, ['query']),
    APPROVAL.READ,
    async (ctx, args) => {
      const { searchMemory, markUsed, memoryStats } = await import('./memory.js');
      const hits = searchMemory(String(args.query), { limit: args.limit || 6, kind: args.kind || '' });
      if (!hits.length) {
        const st = memoryStats();
        return st.count
          ? `No memories match "${args.query}" (${st.count} stored). Answer from the conversation, and use remember if the user states something durable.`
          : 'Long-term memory is empty. Ask only if you genuinely need it, and use remember when the user states something durable.';
      }
      markUsed(hits.map((m) => m.id));
      ctx.onMemory?.();
      return hits.map((m) => `- (id: ${m.id}) [${m.kind}]${m.pinned ? ' (pinned)' : ''} ${m.text}${m.tags?.length ? ` #${m.tags.join(' #')}` : ''}`).join('\n');
    }),

  tool('forget',
    'Delete a long-term memory. Use it when the user corrects something you had stored, asks to be forgotten, or when a memory is now wrong or obsolete.',
    obj({
      query: str('Which memory to remove — text or keywords identifying it.'),
      id: str('Optional exact memory id. Required when several memories match equally — recall lists ids.'),
    }),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const { removeMemory, bestMatch, memories } = await import('./memory.js');
      // deleting is destructive, so an exact id always wins over a fuzzy query
      if (args.id) {
        const target = memories().find((m) => m.id === args.id);
        if (!target) return `No memory has the id "${args.id}" — nothing deleted. Use recall to list ids.`;
        removeMemory(target.id);
        ctx.onMemory?.();
        return `Forgot [${target.kind}] ${target.text}`;
      }
      const match = bestMatch(String(args.query || ''));
      if (!match) return `No memory matched "${args.query}" — nothing deleted.`;
      if (match.ambiguous) {
        return `${match.ambiguous.length} memories match "${args.query}" about equally, so nothing was deleted. Ask the user which one, then call forget with its id:\n` +
          match.ambiguous.map((m) => `- id: ${m.id} [${m.kind}] ${m.text}`).join('\n');
      }
      removeMemory(match.entry.id);
      ctx.onMemory?.();
      return `Forgot [${match.entry.kind}] ${match.entry.text}`;
    }),

  /* ═══ connections: other apps and the web ═══ */
  tool('list_connections',
    'List the external apps/APIs the user has connected (and the presets they could add). Use it before call_connection.',
    obj({}),
    APPROVAL.READ,
    async () => {
      const { listConnections, CONNECTION_PRESETS } = await import('./connections.js');
      const conns = listConnections();
      const lines = conns.length
        ? conns.map((c) => `- ${c.name} (id: ${c.id}) → ${c.baseUrl || '(no URL)'} · auth: ${c.authType}${c.enabled === false ? ' · DISABLED' : ''}${c.description ? `\n  ${c.description}` : ''}`)
        : ['No connections configured yet.'];
      const missing = CONNECTION_PRESETS.filter((p) => !conns.some((c) => c.preset === p.id));
      if (missing.length) lines.push('', `Presets the user can add in the Connect tab: ${missing.map((p) => p.name).join(', ')}`);
      lines.push('', 'There is also web_fetch, which reads any public URL without a connection.');
      return lines.join('\n');
    }),

  tool('call_connection',
    'Call one of the user\'s connected apps/APIs. Use it to read or change data in a service they connected in the Connect tab (search, encyclopaedia, GitHub, a company API, a webhook, a smart-home hub…). Never invent a connection — check list_connections first.',
    obj({
      connection: str('Connection id or exact name from list_connections.'),
      method: str('HTTP method: GET | POST | PUT | PATCH | DELETE. Default GET.'),
      path: str('Path appended to the connection base URL, e.g. "/page/summary/Alan_Turing", or a full URL.'),
      query: { type: 'object', description: 'Optional query parameters as key/value pairs.', additionalProperties: true },
      body: { type: 'object', description: 'Optional JSON body for POST/PUT/PATCH.', additionalProperties: true },
      headers: { type: 'object', description: 'Optional extra request headers.', additionalProperties: true },
    }, ['connection']),
    APPROVAL.NETWORK,
    async (ctx, args) => {
      const { callConnection, listConnections } = await import('./connections.js');
      const wanted = String(args.connection || '').trim();
      const conn = listConnections().find((c) => c.id === wanted || c.name.toLowerCase() === wanted.toLowerCase());
      if (!conn) return `ERROR: no connection named "${wanted}". Run list_connections to see what is available.`;
      const res = await callConnection(conn, {
        method: args.method, path: args.path, query: args.query, body: args.body, headers: args.headers,
        maxChars: ctx.settings?.maxToolOutputChars || 14000,
      });
      const head = `${res.ok ? 'OK' : 'FAILED'} ${res.status} ${res.method || args.method || 'GET'} ${res.url}${res.via === 'puter' ? ' (via Puter proxy — CORS blocked the direct call)' : ''}`;
      if (!res.ok && !res.text) return `${head}\n(empty response body)`;
      return `${head}\n\n${res.json ? JSON.stringify(res.json, null, 2) : res.text}`;
    }),

  tool('web_fetch',
    'Fetch a public web page and read it as text — documentation, a changelog, an API reference, a blog post. HTML is reduced to readable Markdown-ish text. Use it instead of guessing at facts you can look up.',
    obj({
      url: str('Absolute http(s) URL to read.'),
      max_chars: num('Optional cap on returned characters (default 14000).'),
    }, ['url']),
    APPROVAL.NETWORK,
    async (ctx, args) => {
      const { webFetch } = await import('./connections.js');
      const res = await webFetch(String(args.url), { maxChars: args.max_chars || ctx.settings?.maxToolOutputChars || 14000 });
      const head = `${res.ok ? 'OK' : 'FAILED'} ${res.status} ${res.url}${res.title ? ` — ${res.title}` : ''}${res.via === 'puter' ? ' (via Puter proxy)' : ''}`;
      return `${head}\n\n${res.text}`;
    }),

  /* ═══ skills (Agent Skills open standard) ═══ */
  tool('list_skills',
    'List the skills installed in the workspace (SKILL.md folders imported from Claude, ChatGPT, Gemini, Cursor or written here). Each has a name and a description of when to use it.',
    obj({}),
    APPROVAL.READ,
    async (ctx) => {
      const { listSkills } = await import('./skills.js');
      const skills = await listSkills(ctx.ws);
      if (!skills.length) return 'No skills installed. The user can import them in the Skills tab (SKILL.md, a ChatGPT custom GPT, a Gemini Gem, or a .zip).';
      return skills.map((s) => `- ${s.name}${s.enabled ? '' : ' (DISABLED)'}: ${s.description}${s.errors?.length ? `\n  INVALID: ${s.errors.join('; ')}` : ''}${s.allowedTools ? `\n  requests tools: ${s.allowedTools}` : ''}`).join('\n');
    }),

  tool('use_skill',
    'Load a skill\'s full instructions and follow them. Use it when the task matches a skill from list_skills or from the skills index in your prompt. Returns the SKILL.md body plus the files bundled with it.',
    obj({ name: str('Skill name exactly as listed.') }, ['name']),
    APPROVAL.READ,
    async (ctx, args) => {
      const { readSkillBody } = await import('./skills.js');
      const skill = await readSkillBody(ctx.ws, String(args.name));
      if (!skill) return `ERROR: no skill named "${args.name}". Run list_skills.`;
      if (!skill.enabled) return `ERROR: the skill "${skill.name}" is disabled in the Skills tab. Ask the user to enable it.`;
      const head = [`# Skill: ${skill.name}`, skill.description, ''];
      if (skill.compatibility) head.push(`Compatibility: ${skill.compatibility}`);
      if (skill.license) head.push(`License: ${skill.license}`);
      if (skill.allowedTools) head.push(`NOTE: this skill requests pre-approval for: ${skill.allowedTools}. That request is NOT granted automatically — the user still approves each call.`);
      if (skill.files?.length) head.push(`Bundled files (read them with read_file if the instructions say so): ${skill.files.map((f) => f.path).join(', ')}`);
      head.push('', '--- instructions ---', '');
      return head.join('\n') + skill.body;
    }),

  tool('create_skill',
    'Write a new skill into the workspace as skills/<name>/SKILL.md, following the Agent Skills open standard so Claude, ChatGPT, Codex, Gemini CLI and Cursor can all read it. Use it when the user asks to save a repeatable procedure, or after you have done something worth reusing.',
    obj({
      name: str('Kebab-case skill name, max 64 chars: "pdf-table-extract".'),
      description: str('What it does AND when to use it, max 1024 chars. This is what the agent matches tasks against, so be specific.'),
      body: str('Markdown instructions: steps, gotchas, examples. Keep under ~500 lines; move long references into files.'),
      license: str('Optional SPDX licence, e.g. "MIT".'),
      compatibility: str('Optional environment requirements, max 500 chars.'),
      extra_files: { type: 'object', description: 'Optional map of relative path to text content, stored beside SKILL.md (e.g. {"references/api.md": "…"}).' },
      overwrite: bool('Optional: replace an existing skill of the same name.'),
    }, ['name', 'description', 'body']),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const { saveSkill } = await import('./skills.js');
      const saved = await saveSkill(ctx.ws, {
        name: args.name, description: args.description, body: args.body,
        license: args.license, compatibility: args.compatibility,
        metadata: { source: 'agent' }, source: 'agent', overwrite: !!args.overwrite,
      });
      const extras = args.extra_files && typeof args.extra_files === 'object' ? Object.entries(args.extra_files) : [];
      for (const [rel, content] of extras) {
        if (typeof content !== 'string' || !rel || rel.includes('..')) continue;
        await ctx.ws.write(`${saved.dir}/${rel.replace(/^\/+/, '')}`, content);
      }
      ctx.touch?.(saved.path);
      ctx.onSkills?.();
      return `Skill "${saved.name}" written to ${saved.path}${extras.length ? ` (+${extras.length} bundled file(s))` : ''}. It is enabled and will be offered in future turns.`;
    }),

  tool('import_skill',
    'Import a skill from text or a URL: an Agent Skills SKILL.md, a ChatGPT custom-GPT JSON export, a Gemini Gem, or a CLAUDE.md / AGENTS.md rules file. The format is detected automatically.',
    obj({
      url: str('URL of a raw SKILL.md or JSON export (e.g. a raw.githubusercontent.com link).'),
      text: str('Or paste the payload directly.'),
      name: str('Optional name override.'),
      overwrite: bool('Optional: replace an existing skill of the same name.'),
    }),
    APPROVAL.WRITE,
    async (ctx, args) => {
      const { parseImport, saveSkill } = await import('./skills.js');
      let payload = typeof args.text === 'string' ? args.text : '';
      if (!payload && args.url) {
        const { webFetch } = await import('./connections.js');
        const page = await webFetch(String(args.url), { maxChars: 60000, asHtml: false });
        payload = page.text;
      }
      if (!payload) return 'ERROR: supply either `url` or `text`.';
      const parsed = parseImport(payload, { fileName: args.url ? String(args.url).split('/').pop() : '' });
      if (parsed.errors.length) return `ERROR: that payload is not a valid skill: ${parsed.errors.join('; ')}`;
      const saved = await saveSkill(ctx.ws, { ...parsed, name: args.name || parsed.name, source: parsed.kind, overwrite: !!args.overwrite });
      ctx.touch?.(saved.path);
      ctx.onSkills?.();
      const notes = [
        `Imported "${saved.name}" (${parsed.kind}) → ${saved.path}`,
        parsed.warnings.length ? `Warnings: ${parsed.warnings.join('; ')}` : '',
        parsed.allowedTools ? `It requests these tools, which are NOT auto-approved: ${parsed.allowedTools}` : '',
        parsed.metadata?.source === 'chatgpt-custom-gpt' && parsed.hasActions ? 'It has an API action — add that endpoint in the Connect tab to call it.' : '',
      ].filter(Boolean);
      return notes.join('\n');
    }),

  tool('ask_user',
    'Ask the human a question and wait for the answer. Use it when a decision is genuinely ambiguous (repo name, visibility, design direction) — not for things you can decide yourself.',
    obj({
      question: str('The question to show the user.'),
      options: { type: 'array', items: { type: 'string' }, description: 'Optional list of up to 4 suggested answers.' },
    }, ['question']),
    APPROVAL.READ,
    async (ctx, args) => {
      if (!ctx.askUser) return 'ERROR: interactive questions are not available in this context.';
      const answer = await ctx.askUser(String(args.question), Array.isArray(args.options) ? args.options : []);
      return answer ? `The user answered: ${answer}` : 'The user skipped the question — use your best judgement and state your assumption.';
    }),

  tool('finish',
    'Declare the task complete. Provide a concise summary of what was built, which files changed, and any live URLs. This ends the agent loop.',
    obj({ summary: str('Final summary shown to the user (markdown).') }, ['summary']),
    APPROVAL.READ,
    async (ctx, args) => { ctx.finishReason = String(args.summary || 'Done.'); return `FINISHED: ${truncate(String(args.summary || ''), 4000)}`; }),
];

export const ALL_TOOLS = [...fsTools, ...execTools, ...githubTools, ...puterTools];
export const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Native function-calling payloads for puter.ai.chat({tools}). */
export function nativeToolSchemas(names = null) {
  return (names ? ALL_TOOLS.filter((t) => names.includes(t.name)) : ALL_TOOLS).map((t) => t.schema);
}

/** Human-readable tool docs for the text protocol / system prompt. */
export function toolsDoc(names = null) {
  const list = names ? ALL_TOOLS.filter((t) => names.includes(t.name)) : ALL_TOOLS;
  return list.map((t) => {
    const props = t.schema.function.parameters?.properties || {};
    const required = new Set(t.schema.function.parameters?.required || []);
    const params = Object.entries(props).map(([k, v]) => {
      const type = v.type === 'array' ? `array<${v.items?.type || 'any'}>` : v.type;
      return `    - ${k}${required.has(k) ? '' : '?'} (${type}): ${v.description || ''}`;
    }).join('\n');
    return `• ${t.name}\n    ${t.description}${params ? '\n' + params : ''}`;
  }).join('\n\n');
}

export function isWriteTool(name) {
  const t = TOOL_MAP.get(name);
  return !!t && [APPROVAL.WRITE, APPROVAL.EXEC, APPROVAL.GITHUB, APPROVAL.PUBLISH].includes(t.approval);
}
