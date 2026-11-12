/**
 * The built-in templates. Each one is the first thing a new user may see, so
 * the example text shows what good content looks like: short, concrete, and
 * about the work rather than about the tool.
 */
import { TemplateBuilder } from './builder.js';
import type { TemplateBuildOptions, TemplateDef } from './types.js';

const title = (options: TemplateBuildOptions | undefined, fallback: string) =>
  options?.title ?? fallback;

const architectureMap: TemplateDef = {
  id: 'architecture-map',
  name: 'Architecture map',
  description:
    'Map a codebase: its areas as frames, the important modules as code nodes linked to their files, how they depend on each other, and the risks and open questions found along the way. Use it to get or give an overview of a system before changing it.',
  tags: ['code', 'architecture', 'overview'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('map', title(options, 'Architecture map'), {
      body: 'What the system does in a sentence or two, and who uses it.',
    });
    b.frame('edge', 'Interface', { in: 'map' });
    b.node('web', 'code', 'Web client', {
      in: 'edge',
      body: 'Example: the single-page app customers use. Link its entry file.',
    });
    b.node('api', 'code', 'HTTP API', {
      in: 'edge',
      body: 'Example: routes, authentication and request validation.',
    });
    b.frame('domain', 'Domain', { in: 'map' });
    b.node('orders', 'code', 'Orders service', {
      in: 'domain',
      body: 'Example: the rules for placing, changing and cancelling orders.',
    });
    b.node('billing', 'code', 'Billing', {
      in: 'domain',
      body: 'Example: invoices and payment provider calls.',
    });
    b.frame('data', 'Data', { in: 'map' });
    b.node('db', 'code', 'Database access', {
      in: 'data',
      body: 'Example: repositories and queries for the main database.',
    });
    b.node('jobs', 'code', 'Background jobs', {
      in: 'data',
      body: 'Example: the queue worker that sends emails and builds reports.',
    });
    b.frame('risks', 'Risks & questions', { in: 'map' });
    b.node('risk', 'risk', 'One database for everything', {
      in: 'risks',
      body: 'Example: every service writes to the same instance, so one slow query slows all of them.',
    });
    b.node('owner', 'question', 'Who owns billing?', {
      in: 'risks',
      body: 'Example: nobody has changed it in a year and its tests are skipped.',
    });
    b.edge('depends_on', 'web', 'api');
    b.edge('depends_on', 'api', 'orders');
    b.edge('depends_on', 'orders', 'billing');
    b.edge('depends_on', 'orders', 'db');
    b.edge('depends_on', 'billing', 'db');
    b.edge('depends_on', 'jobs', 'db');
    b.edge('relates_to', 'risk', 'db');
    b.edge('relates_to', 'owner', 'billing');
    return b.ops;
  },
};

const featurePlan: TemplateDef = {
  id: 'feature-plan',
  name: 'Feature plan',
  description:
    'Plan one feature from goal to done: the goal and how success shows, tasks with their dependencies and statuses, decisions with their reasons, risks, and open questions. Use it when a piece of work needs more than a single task.',
  tags: ['planning', 'feature'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('plan', title(options, 'Feature plan'));
    b.node('goal', 'note', 'Goal', {
      in: 'plan',
      body: 'Example: customers can export their orders as CSV from the orders page.\nSuccess: no more support tickets asking for exports.',
    });
    b.frame('tasks', 'Tasks', { in: 'plan' });
    b.node('query', 'task', 'Write the export query', {
      in: 'tasks',
      status: 'todo',
      body: 'Done when: orders for a date range come back in one query, oldest first.',
    });
    b.node('endpoint', 'task', 'Add the export endpoint', {
      in: 'tasks',
      status: 'todo',
      body: 'Done when: GET /orders/export streams a CSV file.',
    });
    b.node('button', 'task', 'Add the export button', {
      in: 'tasks',
      status: 'todo',
      body: 'Done when: the orders page offers the export for the current filter.',
    });
    b.frame('decisions', 'Decisions', { in: 'plan' });
    b.node('stream', 'decision', 'Stream rows instead of building the file in memory', {
      in: 'decisions',
      body: 'Why: an export can reach a million rows.\nAlso considered: a background job that emails a link.',
    });
    b.frame('risks', 'Risks', { in: 'plan' });
    b.node('timeout', 'risk', 'Large exports time out', {
      in: 'risks',
      body: 'Likelihood: medium. Impact: users get a cut-off file.\nMitigation: streaming, and a row limit with a clear message.',
    });
    b.frame('questions', 'Open questions', { in: 'plan' });
    b.node('columns', 'question', 'Which columns go into the export?', {
      in: 'questions',
      body: 'Needed before the query can be written.',
    });
    b.edge('depends_on', 'endpoint', 'query');
    b.edge('depends_on', 'button', 'endpoint');
    b.edge('implements', 'endpoint', 'stream');
    b.edge('blocks', 'columns', 'query');
    b.edge('relates_to', 'timeout', 'endpoint');
    b.edge('relates_to', 'goal', 'button');
    return b.ops;
  },
};

const releasePlan: TemplateDef = {
  id: 'release-plan',
  name: 'Release plan',
  description:
    'Prepare and track a release: what is in it, what must happen before it ships, the rollout steps, and how to roll back. Use it for a version, a launch or a migration.',
  tags: ['release', 'planning'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('release', title(options, 'Release plan'), {
      body: 'Example: version 2.4, planned for the first week of the month.',
    });
    b.frame('scope', 'In this release', { in: 'release' });
    b.node('export', 'task', 'Order export', {
      in: 'scope',
      status: 'done',
      body: 'Example of a finished item; link its pull request.',
    });
    b.node('search', 'task', 'Faster search', { in: 'scope', status: 'in_progress' });
    b.node('dark', 'task', 'Dark mode', {
      in: 'scope',
      status: 'cancelled',
      body: 'Moved to the next release.',
    });
    b.frame('before', 'Before release', { in: 'release' });
    b.node('freeze', 'task', 'Freeze the release branch', { in: 'before', status: 'todo' });
    b.node('staging', 'task', 'Run the full test suite on staging', {
      in: 'before',
      status: 'todo',
    });
    b.node('notes', 'task', 'Write the release notes', { in: 'before', status: 'todo' });
    b.frame('rollout', 'Rollout', { in: 'release' });
    b.node('canary', 'task', 'Deploy to 10% of users', { in: 'rollout', status: 'todo' });
    b.node('watch', 'task', 'Watch errors and latency for an hour', {
      in: 'rollout',
      status: 'todo',
    });
    b.node('all', 'task', 'Deploy to everyone', { in: 'rollout', status: 'todo' });
    b.node('rollback', 'note', 'Rollback plan', {
      in: 'release',
      body: 'Example: redeploy the previous version. The migration is backward compatible, so no data step is needed.',
    });
    b.node('reindex', 'risk', 'The search index rebuild takes hours', {
      in: 'release',
      body: 'Start it the day before, or ship search behind a flag.',
    });
    b.edge('depends_on', 'freeze', 'search');
    b.edge('depends_on', 'staging', 'freeze');
    b.edge('depends_on', 'canary', 'staging');
    b.edge('depends_on', 'canary', 'notes');
    b.edge('depends_on', 'watch', 'canary');
    b.edge('depends_on', 'all', 'watch');
    b.edge('relates_to', 'reindex', 'search');
    b.edge('relates_to', 'rollback', 'canary');
    return b.ops;
  },
};

const incidentReview: TemplateDef = {
  id: 'incident-review',
  name: 'Incident review',
  description:
    'Look back at an incident without blame: what happened when, what it affected, why it was possible, and what will change. Use it after an outage, a data problem or a near miss.',
  tags: ['incident', 'review', 'postmortem'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('review', title(options, 'Incident review'), {
      body: 'Example: checkout failed for 40 minutes on a Tuesday afternoon.',
    });
    b.frame('timeline', 'Timeline', { in: 'review' });
    b.node('t1', 'note', '14:02 Alerts fire for checkout errors', {
      in: 'timeline',
      body: 'One note per moment, with the time first.',
    });
    b.node('t2', 'note', '14:10 On-call starts investigating', { in: 'timeline' });
    b.node('t3', 'note', '14:35 The config change is rolled back', { in: 'timeline' });
    b.node('t4', 'note', '14:42 Error rate back to normal', { in: 'timeline' });
    b.frame('impact', 'Impact', { in: 'review' });
    b.node('affected', 'note', 'What was affected', {
      in: 'impact',
      body: 'Example: about 1,200 failed checkouts, no data lost, 85 support tickets.',
    });
    b.frame('causes', 'Causes', { in: 'review' });
    b.node('cause1', 'risk', 'A config change went live without review', {
      in: 'causes',
      body: 'Example of a contributing cause: what made the mistake possible, not who made it.',
    });
    b.node('cause2', 'risk', 'No alert on the payment error rate', {
      in: 'causes',
      body: 'It took 8 minutes to notice that only payments failed.',
    });
    b.frame('actions', 'Actions', { in: 'review' });
    b.node('a1', 'task', 'Require review for config changes', {
      in: 'actions',
      status: 'todo',
      body: 'Owner and due date go here.',
    });
    b.node('a2', 'task', 'Alert on the payment error rate', { in: 'actions', status: 'todo' });
    b.edge('flows_to', 't1', 't2');
    b.edge('flows_to', 't2', 't3');
    b.edge('flows_to', 't3', 't4');
    b.edge('evidence_for', 't3', 'cause1');
    b.edge('evidence_for', 't2', 'cause2');
    b.edge('relates_to', 'a1', 'cause1', 'addresses');
    b.edge('relates_to', 'a2', 'cause2', 'addresses');
    return b.ops;
  },
};

const decisionRecord: TemplateDef = {
  id: 'decision-record',
  name: 'Decision record',
  description:
    'Record one decision with its context: the problem, the options weighed with the evidence for and against each, what was decided, and what follows from it. Use it for choices that are hard to reverse or that others will ask about later.',
  tags: ['decision', 'adr'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('record', title(options, 'Decision record'));
    b.node('context', 'note', 'Context', {
      in: 'record',
      body: 'Example: the nightly report job takes 3 hours and blocks deploys. It has to finish in under 30 minutes.',
    });
    b.frame('options', 'Options', { in: 'record' });
    b.node('optA', 'note', 'Option A: run the job on a read replica', {
      in: 'options',
      body: 'Cost: a replica, about $200 a month. Effort: two days.',
    });
    b.node('optB', 'note', 'Option B: build the report incrementally', {
      in: 'options',
      body: 'Cost: none. Effort: about three weeks.',
    });
    b.frame('evidence', 'Evidence', { in: 'record' });
    b.node('bench', 'doc', 'Benchmark: the job on a replica took 25 minutes', {
      in: 'evidence',
      body: 'Link the measurement or the notebook.',
    });
    b.node('estimate', 'note', 'Estimate for the incremental rewrite', {
      in: 'evidence',
      body: 'Example: three weeks, with risk in the billing joins.',
    });
    b.node('decision', 'decision', 'Run the report job on a read replica', {
      in: 'record',
      status: 'done',
      body: 'Who decided, and when. Why: fastest way under 30 minutes; option B stays open for later.',
    });
    b.node('consequences', 'note', 'Consequences', {
      in: 'record',
      body: 'Example: reports can be up to 5 minutes stale; the replica needs monitoring.',
    });
    b.edge('evidence_for', 'bench', 'optA', 'for');
    b.edge('evidence_for', 'estimate', 'optB', 'against');
    b.edge('relates_to', 'context', 'decision');
    b.edge('relates_to', 'decision', 'optA', 'chosen');
    b.edge('flows_to', 'decision', 'consequences');
    return b.ops;
  },
};

const researchMap: TemplateDef = {
  id: 'research-map',
  name: 'Research map',
  description:
    'Organise research around a question: the sources read, the findings they support, and how each finding bears on the question. Use it for a technical investigation, user research or a literature review.',
  tags: ['research'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('research', title(options, 'Research map'));
    b.node('question', 'question', 'Why do trial users not convert?', {
      in: 'research',
      body: 'Example: one main question per map; narrower questions hang off it.',
    });
    b.node('sub', 'question', 'Would a longer trial help?', { in: 'research' });
    b.frame('sources', 'Sources', { in: 'research' });
    b.node('interviews', 'doc', 'Interviews with 8 trial users', {
      in: 'sources',
      body: 'Where the notes are, when they were taken, and how reliable they are.',
    });
    b.node('funnel', 'doc', 'Funnel analytics, last 90 days', { in: 'sources' });
    b.node('tickets', 'doc', 'Support tickets about the trial', { in: 'sources' });
    b.frame('findings', 'Findings', { in: 'research' });
    b.node('setup', 'note', 'Setup takes longer than the trial', {
      in: 'findings',
      body: 'Example: 5 of 8 users had not finished setup when their trial ended.',
    });
    b.node('pricing', 'note', 'Few users leave from the pricing page', {
      in: 'findings',
      body: 'Example: 4% of exits, against 61% during setup.',
    });
    b.edge('evidence_for', 'interviews', 'setup');
    b.edge('evidence_for', 'funnel', 'setup');
    b.edge('evidence_for', 'funnel', 'pricing');
    b.edge('evidence_for', 'tickets', 'setup');
    b.edge('evidence_for', 'setup', 'question');
    b.edge('evidence_for', 'pricing', 'question');
    b.edge('relates_to', 'sub', 'question');
    return b.ops;
  },
};

const kanban: TemplateDef = {
  id: 'kanban',
  name: 'Kanban',
  description:
    'Work by stage: to do, in progress, review and done, with example tasks and statuses. Use it to see at a glance what a small team, or a group of agents, is working on.',
  tags: ['tasks', 'workflow'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('board', title(options, 'Kanban'));
    b.frame('todo', 'To do', { in: 'board' });
    b.node('search', 'task', 'Add search to the orders page', { in: 'todo', status: 'todo' });
    b.node('dates', 'task', 'Fix the date format in exports', { in: 'todo', status: 'todo' });
    b.frame('doing', 'In progress', { in: 'board' });
    b.node('upgrade', 'task', 'Upgrade the payment library', {
      in: 'doing',
      status: 'in_progress',
    });
    b.node('emails', 'task', 'Write the onboarding emails', {
      in: 'doing',
      status: 'blocked',
      body: 'Blocked: waiting for the final copy from marketing.',
    });
    b.frame('review', 'Review', { in: 'board' });
    b.node('limit', 'task', 'Rate-limit the public API', {
      in: 'review',
      status: 'in_progress',
      body: 'Ready for review: what changed and how it was tested.',
    });
    b.frame('done', 'Done', { in: 'board' });
    b.node('tracking', 'task', 'Set up error tracking', { in: 'done', status: 'done' });
    b.edge('flows_to', 'todo', 'doing');
    b.edge('flows_to', 'doing', 'review');
    b.edge('flows_to', 'review', 'done');
    return b.ops;
  },
};

const agentTeam: TemplateDef = {
  id: 'agent-team',
  name: 'Agent team',
  description:
    'Coordinate several agents on one board: a work queue of tasks, the work in progress and who holds it, and a review area where people check finished work. Use it when more than one agent works on the same project.',
  tags: ['agents', 'coordination', 'tasks'],
  build(options) {
    const b = new TemplateBuilder();
    b.frame('team', title(options, 'Agent team'));
    b.node('how', 'note', 'How work moves on this board', {
      in: 'team',
      body: 'Tasks wait in the work queue. Whoever picks one up claims it first, so nobody else takes it at the same time; the claim shows on the card and lapses after 15 minutes without activity. Work being done sits in In progress, finished work in Review until a person accepts it.',
    });
    b.frame('roles', 'Team', { in: 'team' });
    b.node('builder', 'agent', 'Implementer', {
      in: 'roles',
      body: 'Takes tasks from the queue and writes the code and tests.',
    });
    b.node('checker', 'agent', 'Reviewer', {
      in: 'roles',
      body: 'Reads finished work and its tests before a person looks at it.',
    });
    b.frame('queue', 'Work queue', { in: 'team' });
    b.node('signup', 'task', 'Validate the signup form', {
      in: 'queue',
      status: 'todo',
      body: 'Done when: invalid emails and short passwords get a clear message.',
    });
    b.node('tests', 'task', 'Write tests for the export endpoint', {
      in: 'queue',
      status: 'todo',
    });
    b.node('docs', 'task', 'Update the API docs for v2', { in: 'queue', status: 'todo' });
    b.frame('doing', 'In progress', { in: 'team' });
    b.node('migrate', 'task', 'Move the jobs table to the new schema', {
      in: 'doing',
      status: 'in_progress',
      body: 'Progress notes go here: what is done, what is next.',
    });
    b.frame('review', 'Review', { in: 'team' });
    b.node('flaky', 'task', 'Fix the flaky login test', {
      in: 'review',
      status: 'in_progress',
      body: 'Ready for review: the cause, the fix, and how it was checked.',
    });
    b.edge('relates_to', 'builder', 'migrate', 'working on');
    b.edge('relates_to', 'checker', 'flaky', 'reviewing');
    b.edge('flows_to', 'queue', 'doing');
    b.edge('flows_to', 'doing', 'review');
    return b.ops;
  },
};

/** Every built-in template, in the order they are listed. */
export const BUILTIN_TEMPLATES: readonly TemplateDef[] = [
  featurePlan,
  architectureMap,
  releasePlan,
  incidentReview,
  decisionRecord,
  researchMap,
  kanban,
  agentTeam,
];

export function findBuiltinTemplate(id: string): TemplateDef | undefined {
  return BUILTIN_TEMPLATES.find((template) => template.id === id);
}
