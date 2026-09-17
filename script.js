/*
  PromptLens rule engine
  -----------------------
  Each rule inspects the raw prompt text and returns a flag object if triggered.
  A rule never talks to a network or an LLM — everything here is regex / string
  heuristics, same "pattern-based" approach as HalluDetect uses on the output side.
  That's a deliberate choice: it keeps the tool fast, offline, and fully explainable
  in an interview — every flag traces back to one readable condition.
*/

const RULES = [
  {
    id: 'too_short',
    weight: 25,
    severity: 'high',
    title: 'Prompt is very short / underspecified',
    test: (p) => p.trim().length < 40,
    explain: 'Short prompts leave most of the design decisions to the model. The less you constrain, the more the model fills gaps with plausible-sounding guesses.',
    fix: 'Add what the input looks like, what the output should look like, and any constraints (language, framework, performance, edge cases).'
  },
  {
    id: 'no_stack_context',
    weight: 12,
    severity: 'medium',
    test: (p) => {
      const asksToBuild = /\b(build|write|create|implement|develop|make)\b/i.test(p);
      const stackWords = /\b(python|javascript|typescript|java|c\+\+|c#|go|golang|rust|php|ruby|swift|kotlin|react|vue|angular|svelte|node|express|django|flask|spring|next\.?js|flutter|html|css|sql|dart)\b/i;
      return asksToBuild && !stackWords.test(p);
    },
    title: 'No language or framework specified',
    explain: 'Without a named stack, the model picks one for you — often whichever is most common in its training data, not what your project actually uses.',
    fix: 'Name the language, framework, and version you\'re working in, even if it feels obvious to you.'
  },
  {
    id: 'unpinned_dependency',
    weight: 12,
    severity: 'medium',
    test: (p) => {
      const libWords = /\b(react|next\.?js|vue|angular|express|django|flask|numpy|pandas|tensorflow|pytorch|axios|lodash|spring|laravel|node)\b/i;
      const hasVersion = /\bv?\d+\.\d+(\.\d+)?\b/.test(p);
      return libWords.test(p) && !hasVersion;
    },
    title: 'Library mentioned without a version',
    explain: 'APIs change fast between major versions. Without a version pin, the model may blend syntax from several versions it saw in training — a common source of invented methods.',
    fix: 'State the exact version you\'re on, e.g. "React 18" or "Django 5.0", not just the library name.'
  },
  {
    id: 'recency_sensitive',
    weight: 15,
    severity: 'high',
    test: (p) => /\b(latest|newest|most recent|just released|brand new|cutting.?edge|current version)\b/i.test(p),
    title: 'Asks for "latest" / newest anything',
    explain: 'Every model has a training cutoff. Asking for the "latest" version of a tool invites it to describe something from before its cutoff as if it were current — or invent details for something it never saw.',
    fix: 'Name the exact version or date you mean, and double-check anything version-specific yourself.'
  },
  {
    id: 'no_examples',
    weight: 10,
    severity: 'medium',
    test: (p) => !/\b(example|e\.g\.|for instance|sample|input:|output:)\b/i.test(p),
    title: 'No input/output example given',
    explain: 'Without a concrete example, the model has to guess your expected data shape and format — a frequent cause of subtly wrong return types or field names.',
    fix: 'Add one small example: a sample input and the exact output you expect from it.'
  },
  {
    id: 'vague_language',
    weight: 10,
    severity: 'medium',
    test: (p) => {
      const matches = p.match(/\b(properly|correctly|efficiently|robust|appropriately|as needed|best practices|clean code|handle it)\b/gi);
      return matches && matches.length > 0;
    },
    title: 'Relies on vague quality words',
    explain: 'Words like "properly" or "best practices" carry no testable meaning. The model will satisfy them with whatever pattern looks confident, not necessarily what you had in mind.',
    fix: 'Replace vague words with a concrete rule: what should happen, and what should NOT happen.'
  },
  {
    id: 'superlative_request',
    weight: 10,
    severity: 'medium',
    test: (p) => /\b(the best|most secure|most efficient|industry standard|production.?ready|enterprise.?grade|state of the art|world.?class|flawless|perfect)\b/i.test(p),
    title: 'Asks for an unqualified superlative',
    explain: 'There is no single "best" or "most secure" implementation in the abstract. Asked this way, the model tends to assert confidence rather than surface the real trade-offs.',
    fix: 'Say what "best" means for your case — e.g. "fastest to write" vs "fastest to run" vs "easiest to test".'
  },
  {
    id: 'absolute_certainty_request',
    weight: 12,
    severity: 'medium',
    test: (p) => /\b(100%|guarantee|guaranteed|bug.?free|never fail|always work|fully secure|totally secure)\b/i.test(p),
    title: 'Demands a certainty no model can back up',
    explain: 'Asking a generator to guarantee correctness pushes it to sound certain rather than to flag its own limitations — the opposite of what you want before you\'ve tested anything.',
    fix: 'Ask for the model\'s known limitations or untested edge cases explicitly, instead of asking it to promise there are none.'
  },
  {
    id: 'no_constraints',
    weight: 8,
    severity: 'low',
    test: (p) => p.trim().length > 60 && !/\b(error|exception|edge case|validate|invalid|null|fail|try.?catch)\b/i.test(p),
    title: 'No error handling or edge cases mentioned',
    explain: 'A substantial ask with no mention of failure modes usually gets a "happy path only" answer, with edge cases silently assumed away.',
    fix: 'List at least one edge case or invalid input you care about (empty input, network failure, wrong type, etc.).'
  },
  {
    id: 'multi_task_overload',
    weight: 15,
    severity: 'high',
    test: (p) => {
      const andCount = (p.match(/\band\b/gi) || []).length;
      const listItems = (p.match(/(^|\n)\s*(\d+[\.\)]|-|\*)\s+/g) || []).length;
      return andCount >= 3 || listItems >= 4;
    },
    title: 'Bundles many distinct tasks into one prompt',
    explain: 'The more separate asks packed into one prompt, the more the model has to juggle at once — and gaps between tasks are where invented "glue code" tends to appear.',
    fix: 'Split this into smaller prompts, one task at a time, and build on the verified result of each.'
  }
];

const promptInput = document.getElementById('promptInput');
const scanBtn = document.getElementById('scanBtn');
const charCount = document.getElementById('charCount');
const resultPanel = document.getElementById('resultPanel');
const gaugeFill = document.getElementById('gaugeFill');
const gaugeScore = document.getElementById('gaugeScore');
const gaugeLabel = document.getElementById('gaugeLabel');
const gaugeSummary = document.getElementById('gaugeSummary');
const flagsList = document.getElementById('flagsList');
const loadRiskyBtn = document.getElementById('loadRisky');
const loadCleanBtn = document.getElementById('loadClean');

const CIRCUMFERENCE = 2 * Math.PI * 60; // r=60

// Two ready-made prompts, kept here so a live demo doesn't depend on
// typing something up on the spot.
const EXAMPLES = {
  risky: `Build me a function that handles user data properly and follows best practices. Use the latest version of the library and make sure it's 100% secure. Also add a login page and connect it to a database and add an admin dashboard.`,
  clean: `Write a Python 3.12 function called normalize_email(email: str) -> str that lowercases an email address and strips leading/trailing whitespace. Example: normalize_email("  User@Example.COM ") should return "user@example.com". Raise a ValueError if the input has no "@" character.`
};

function refreshCharCount() {
  const len = promptInput.value.length;
  charCount.textContent = `${len} characters`;
  scanBtn.disabled = len === 0;
}

promptInput.addEventListener('input', refreshCharCount);

loadRiskyBtn.addEventListener('click', () => {
  promptInput.value = EXAMPLES.risky;
  refreshCharCount();
  promptInput.focus();
});

loadCleanBtn.addEventListener('click', () => {
  promptInput.value = EXAMPLES.clean;
  refreshCharCount();
  promptInput.focus();
});

scanBtn.addEventListener('click', () => {
  const text = promptInput.value;
  const triggered = RULES.filter(rule => rule.test(text));

  const rawScore = triggered.reduce((sum, r) => sum + r.weight, 0);
  const score = Math.min(100, rawScore);

  let band, color, summary;
  if (score <= 33) {
    band = 'In Focus'; color = '#4FD1A5';
    summary = 'Few risk signals detected. This prompt gives a generator enough to work with.';
  } else if (score <= 66) {
    band = 'Soft Focus'; color = '#F2B84B';
    summary = 'Some gaps that a model will likely fill in on its own. Worth tightening before you send it.';
  } else {
    band = 'Out of Focus'; color = '#DC4B3A';
    summary = 'Several risk signals stacked together. High chance the output includes confident guesses.';
  }

  gaugeScore.textContent = score;
  gaugeLabel.textContent = band;
  gaugeSummary.textContent = summary;
  gaugeFill.setAttribute('stroke', color);
  const offset = CIRCUMFERENCE * (1 - score / 100);
  gaugeFill.style.strokeDashoffset = offset;

  flagsList.innerHTML = '';
  if (triggered.length === 0) {
    flagsList.innerHTML = '<div class="clean-state">No heuristic flags triggered on this prompt.</div>';
  } else {
    triggered
      .sort((a, b) => b.weight - a.weight)
      .forEach(rule => {
        const el = document.createElement('div');
        el.className = `flag sev-${rule.severity}`;
        el.innerHTML = `
          <div class="flag-head">
            <span class="flag-title">${rule.title}</span>
            <span class="flag-sev">${rule.severity}</span>
          </div>
          <p>${rule.explain}</p>
          <p class="fix"><b>Fix:</b> ${rule.fix}</p>
        `;
        flagsList.appendChild(el);
      });
  }

  resultPanel.hidden = false;
});