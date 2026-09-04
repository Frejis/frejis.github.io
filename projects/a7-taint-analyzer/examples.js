// Bundled example programs, shared by the UI and the tests so both exercise
// the same source of truth.

export const EXAMPLES = [
  {
    id: 'vulnerable',
    title: 'Classic SQL injection',
    blurb: 'A query parameter flows straight into a SQL string. Flags one finding.',
    code: `function handler(request) {
  let name = request.query.name;
  let sql = "SELECT * FROM users WHERE name = '" + name + "'";
  db.query(sql);
}
`,
  },
  {
    id: 'sanitized',
    title: 'Correctly sanitized',
    blurb: 'Same shape, but the value is escaped before use. Zero findings.',
    code: `function handler(request) {
  let name = request.query.name;
  let safe = escape(name);
  let sql = "SELECT * FROM users WHERE name = '" + safe + "'";
  db.query(sql);
}
`,
  },
  {
    id: 'loop',
    title: 'Loop-carried taint',
    blurb: 'Taint accumulates across loop iterations. Forces the fixed point to actually iterate.',
    code: `function handler(request) {
  let items = request.query.list;
  let out = "";
  let i = 0;
  while (i < 5) {
    out = out + items;
    i = i + 1;
  }
  db.query(out);
}
`,
  },
  {
    id: 'one-branch',
    title: 'Sanitized on only one branch',
    blurb: 'The else branch forgets to sanitize. Merge-point join still must flag it.',
    code: `function handler(request) {
  let name = request.query.name;
  if (request.query.mode == "safe") {
    name = escape(name);
  } else {
    name = name;
  }
  db.query("SELECT * FROM users WHERE name = '" + name + "'");
}
`,
  },
  {
    id: 'both-branches',
    title: 'Sanitized on every branch (false-positive trap)',
    blurb: 'Both branches escape before the merge. A naive analysis without a proper join could still flag this — this one does not.',
    code: `function handler(request) {
  let name = request.query.name;
  if (request.query.mode == "safe") {
    name = escape(name);
  } else {
    name = escape(name);
  }
  db.query("SELECT * FROM users WHERE name = '" + name + "'");
}
`,
  },
  {
    id: 'indirect',
    title: 'Indirection through unrelated variables',
    blurb: 'Taint has to travel through a variable never touched by a sink call directly.',
    code: `function handler(request) {
  let raw = request.body.comment;
  let trimmed = raw;
  let payload = "<div>" + trimmed + "</div>";
  element.innerHTML = payload;
}
`,
  },
];

export const DEFAULT_EXAMPLE_ID = 'vulnerable';
