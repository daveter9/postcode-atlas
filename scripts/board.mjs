#!/usr/bin/env node
// Kanban board voor postcode-atlas op GitHub Projects, bediend via de gh CLI.
//
// Eenmalig:  gh auth login --web -s project
//            npm run board -- setup
//
// Gebruik:   npm run board -- list
//            npm run board -- add "Titel" [--body "tekst"] [--label bug,ui] [--status Backlog]
//            npm run board -- move <issue#> "In Progress"
//            npm run board -- edit <issue#> [--title "..."] [--body "..."] [--label x]
//            npm run board -- close <issue#>        (gaat vanzelf naar Done)
//            npm run board -- reopen <issue#>
//            npm run board -- statuses
//            npm run board -- todo [kolom]           (open tickets + comments als JSON, standaard Todo)
//            npm run board -- comment <issue#> "tekst"
//
// Tickets zijn gewone GitHub Issues; het board is een GitHub Project (v2) waarvan
// de kolommen de opties van het veld "Status" zijn. IDs worden elke keer op naam
// opgezocht, dus kolommen hernoemen of toevoegen in de UI werkt gewoon.

import { execFileSync } from 'node:child_process';

const OWNER = 'daveter9';
const REPO = 'postcode-atlas';
const PROJECT_TITLE = 'Postcode Atlas';
const GH = process.env.GH_BIN || 'gh';

function gh(args, { json = false, input } = {}) {
  let out;
  try {
    out = execFileSync(GH, args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim();
    throw new Error(msg || `gh ${args[0]} faalde`);
  }
  return json ? JSON.parse(out) : out.trim();
}

function graphql(query, vars = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  return gh(args, { json: true }).data;
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opt[key] = true;
      else opt[key] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

// ---------- project & velden ----------

function findProject() {
  const d = graphql(
    `query($login:String!){ user(login:$login){ projectsV2(first:100){ nodes{ id number title url closed } } } }`,
    { login: OWNER },
  );
  return d.user.projectsV2.nodes.find((p) => p.title === PROJECT_TITLE && !p.closed) || null;
}

function requireProject() {
  const p = findProject();
  if (!p) throw new Error(`Project "${PROJECT_TITLE}" niet gevonden. Draai eerst: npm run board -- setup`);
  return p;
}

function statusField(projectId) {
  const d = graphql(
    `query($p:ID!){ node(id:$p){ ... on ProjectV2 { field(name:"Status"){ ... on ProjectV2SingleSelectField { id options{ id name } } } } } }`,
    { p: projectId },
  );
  const f = d.node.field;
  if (!f) throw new Error('Het project heeft geen veld "Status".');
  return f;
}

function resolveOption(field, name) {
  const want = name.trim().toLowerCase();
  const opt =
    field.options.find((o) => o.name.toLowerCase() === want) ||
    field.options.find((o) => o.name.toLowerCase().replace(/\s+/g, '') === want.replace(/[\s-_]+/g, ''));
  if (!opt) {
    throw new Error(`Onbekende kolom "${name}". Kies uit: ${field.options.map((o) => o.name).join(', ')}`);
  }
  return opt;
}

// ---------- issues & items ----------

function issueWithItems(number) {
  const d = graphql(
    `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ id number title url
       projectItems(first:20){ nodes{ id project{ id } } } } } }`,
    { o: OWNER, r: REPO, n: number },
  );
  const issue = d.repository.issue;
  if (!issue) throw new Error(`Issue #${number} bestaat niet.`);
  return issue;
}

function ensureItem(project, issue) {
  const existing = issue.projectItems.nodes.find((i) => i.project.id === project.id);
  if (existing) return existing.id;
  const d = graphql(
    `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`,
    { p: project.id, c: issue.id },
  );
  return d.addProjectV2ItemById.item.id;
}

function setStatus(project, itemId, statusName) {
  const field = statusField(project.id);
  const opt = resolveOption(field, statusName);
  graphql(
    `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`,
    { p: project.id, i: itemId, f: field.id, o: opt.id },
  );
  return opt.name;
}

/** Alle open issues van deze repo op het board, met status, labels en comments, in één query. */
function fetchTickets(project) {
  const tickets = [];
  let after = null;
  do {
    const d = graphql(
      `query($p:ID!,$after:String){ node(id:$p){ ... on ProjectV2 { items(first:50, after:$after){
         pageInfo{ hasNextPage endCursor }
         nodes{
           status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
           content{ ... on Issue { number title body url state repository{ nameWithOwner }
             labels(first:20){ nodes{ name } }
             comments(last:100){ nodes{ body createdAt author{ login } } } } } } } } } }`,
      after ? { p: project.id, after } : { p: project.id },
    );
    const page = d.node.items;
    for (const it of page.nodes) {
      const c = it.content;
      if (!c?.number || c.state !== 'OPEN' || c.repository.nameWithOwner !== `${OWNER}/${REPO}`) continue;
      tickets.push({
        number: c.number,
        title: c.title,
        url: c.url,
        status: it.status?.name ?? null,
        body: c.body,
        labels: c.labels.nodes,
        comments: c.comments.nodes,
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return tickets;
}

function issueNumber(arg) {
  const n = Number(String(arg ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Geen geldig issuenummer: ${arg}`);
  return n;
}

// ---------- commando's ----------

const commands = {
  setup() {
    let p = findProject();
    if (p) {
      console.log(`Project bestaat al: ${p.url}`);
    } else {
      const d = graphql(
        `query($o:String!,$r:String!){ user(login:$o){ id } repository(owner:$o,name:$r){ id } }`,
        { o: OWNER, r: REPO },
      );
      const c = graphql(
        `mutation($owner:ID!,$title:String!,$repo:ID!){ createProjectV2(input:{ownerId:$owner,title:$title,repositoryId:$repo}){ projectV2{ id number url } } }`,
        { owner: d.user.id, title: PROJECT_TITLE, repo: d.repository.id },
      );
      p = c.createProjectV2.projectV2;
      console.log(`Project aangemaakt en gekoppeld aan ${OWNER}/${REPO}: ${p.url}`);
    }
    const f = statusField(p.id);
    console.log(`Kolommen: ${f.options.map((o) => o.name).join(' | ')}`);
  },

  statuses() {
    const p = requireProject();
    console.log(statusField(p.id).options.map((o) => o.name).join('\n'));
  },

  list() {
    const p = requireProject();
    const items = [];
    let after = null;
    do {
      const d = graphql(
        `query($p:ID!,$after:String){ node(id:$p){ ... on ProjectV2 { items(first:100, after:$after){
           pageInfo{ hasNextPage endCursor }
           nodes{ id
             status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
             content{ __typename ... on Issue { number title state } ... on PullRequest { number title state } ... on DraftIssue { title } } } } } } }`,
        after ? { p: p.id, after } : { p: p.id },
      );
      const page = d.node.items;
      items.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);

    const order = statusField(p.id).options.map((o) => o.name);
    const groups = new Map([...order, '(geen status)'].map((n) => [n, []]));
    for (const it of items) {
      const key = it.status?.name ?? '(geen status)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    for (const [name, list] of groups) {
      if (!list.length && name === '(geen status)') continue;
      console.log(`\n${name} (${list.length})`);
      for (const it of list) {
        const c = it.content || {};
        const ref = c.number ? `#${c.number}` : 'draft';
        const closed = c.state && c.state !== 'OPEN' ? ` [${c.state.toLowerCase()}]` : '';
        console.log(`  ${ref.padEnd(6)} ${c.title ?? '(geen toegang)'}${closed}`);
      }
    }
    console.log(`\n${p.url}`);
  },

  add(pos, opt) {
    const title = pos[0];
    if (!title) throw new Error('Gebruik: add "Titel" [--body ...] [--label a,b] [--status Backlog]');
    const p = requireProject();
    const args = ['issue', 'create', '--repo', `${OWNER}/${REPO}`, '--title', title, '--body', opt.body || ''];
    if (opt.label) args.push('--label', opt.label);
    if (opt.assignee) args.push('--assignee', opt.assignee);
    const url = gh(args).split('\n').pop();
    const number = issueNumber(url.split('/').pop());
    const issue = issueWithItems(number);
    const itemId = ensureItem(p, issue);
    const status = setStatus(p, itemId, typeof opt.status === 'string' ? opt.status : 'Backlog');
    console.log(`#${number} "${title}" → ${status}\n${url}`);
  },

  move(pos) {
    const number = issueNumber(pos[0]);
    const statusName = pos.slice(1).join(' ');
    if (!statusName) throw new Error('Gebruik: move <issue#> "<kolom>"');
    const p = requireProject();
    const issue = issueWithItems(number);
    const itemId = ensureItem(p, issue);
    const status = setStatus(p, itemId, statusName);
    console.log(`#${number} "${issue.title}" → ${status}`);
  },

  edit(pos, opt) {
    const number = issueNumber(pos[0]);
    const args = ['issue', 'edit', String(number), '--repo', `${OWNER}/${REPO}`];
    if (typeof opt.title === 'string') args.push('--title', opt.title);
    if (typeof opt.body === 'string') args.push('--body', opt.body);
    if (typeof opt['body-file'] === 'string') args.push('--body-file', opt['body-file']);
    if (typeof opt.label === 'string') args.push('--add-label', opt.label);
    if (typeof opt['remove-label'] === 'string') args.push('--remove-label', opt['remove-label']);
    if (args.length === 5) throw new Error('Gebruik: edit <issue#> [--title ...] [--body ...] [--label a,b] [--remove-label c]');
    console.log(gh(args));
  },

  // Alle open tickets in een kolom (standaard Todo) met volledige tekst en comments, als JSON.
  todo(pos) {
    const p = requireProject();
    const want = resolveOption(statusField(p.id), pos.join(' ') || 'Todo').name;
    console.log(JSON.stringify(fetchTickets(p).filter((t) => t.status === want), null, 2));
  },

  comment(pos, opt) {
    const number = issueNumber(pos[0]);
    const body = typeof opt.body === 'string' ? opt.body : pos.slice(1).join(' ');
    if (!body) throw new Error('Gebruik: comment <issue#> "tekst"  of  comment <issue#> --body "tekst"');
    console.log(gh(['issue', 'comment', String(number), '--repo', `${OWNER}/${REPO}`, '--body', body]));
  },

  close(pos) {
    const number = issueNumber(pos[0]);
    gh(['issue', 'close', String(number), '--repo', `${OWNER}/${REPO}`]);
    console.log(`#${number} gesloten (het board zet hem via de ingebouwde workflow op Done).`);
  },

  reopen(pos) {
    const number = issueNumber(pos[0]);
    gh(['issue', 'reopen', String(number), '--repo', `${OWNER}/${REPO}`]);
    console.log(`#${number} heropend.`);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.log(`Commando's: ${Object.keys(commands).join(', ')}\nZie de kop van scripts/board.mjs voor voorbeelden.`);
  process.exit(cmd ? 1 : 0);
}
try {
  const { pos, opt } = parseArgs(rest);
  commands[cmd](pos, opt);
} catch (e) {
  console.error(`Fout: ${e.message}`);
  process.exit(1);
}
