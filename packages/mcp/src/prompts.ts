/** The text of the server's prompts. Each is one instruction message for the agent. */

function onBoard(board: string | undefined): string {
  return board ? `board ${JSON.stringify(board)}` : 'the default board';
}

function boardArg(board: string | undefined): string {
  return board ? ` (pass board: ${JSON.stringify(board)} to every tool)` : '';
}

export function mapCodebasePrompt(board: string | undefined): string {
  return [
    `Map this repository's architecture onto OpenBoard, on ${onBoard(board)}${boardArg(board)}.`,
    '',
    '1. Explore the repository first: README, package manifests, entry points, top-level directories. Settle on 4 to 10 areas (packages, services or layers).',
    '2. Call board_outline. If the board already maps some of this, extend and correct it instead of duplicating it (find existing nodes with board_read, using text or types).',
    '3. Write the map in one board_apply batch, using refs:',
    '   - one frame per area;',
    '   - inside each frame, code nodes for the modules that matter, each with a one-line body on its responsibility and links [{"kind":"file","target":"<repo-relative path>"}];',
    '   - depends_on edges from a module to what it imports or calls, and flows_to edges where data flow matters;',
    '   - a risk node for each fragile spot you found, and a question node for anything unclear.',
    '   Aim for 15 to 40 nodes: what a new engineer needs, not every file. Set reason, for example "Map of the architecture". Do not set coordinates.',
    '4. If the batch is refused, fix the listed ops and send it again.',
    '',
    'Finish with a short summary for the user that names the frames.',
  ].join('\n');
}

export function planWorkPrompt(goal: string, board: string | undefined): string {
  return [
    `Plan this goal on OpenBoard, on ${onBoard(board)}${boardArg(board)}:`,
    JSON.stringify(goal),
    '',
    '1. Call board_outline, then board_read the parts that relate to the goal, so the plan builds on what is already there. If the user pointed at something, call board_selection.',
    '2. Look at the code and context enough to make the plan concrete.',
    '3. Write the plan in one board_apply batch, using refs:',
    '   - a frame titled after the goal;',
    '   - inside it, task nodes (status todo), each small enough to finish in one sitting, with a body that says what done means and links to the files it touches;',
    '   - decision nodes for choices to make, with the options in the body; risk nodes for what could go wrong; question nodes for what only the user can answer;',
    '   - edges: depends_on from a task to what must happen first, blocks where one item stops another, relates_to for the rest.',
    '   Set reason. Do not set coordinates.',
    '',
    'Then give the user the plan in a few lines and list the open questions by id.',
  ].join('\n');
}
