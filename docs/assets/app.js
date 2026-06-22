/* ============================================================================
   goaly landing page — interactivity (vanilla JS, no libraries)
   Everything is defensive: a missing element never throws.
   ========================================================================== */
(function () {
  "use strict";
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------------- mobile nav */
  const navToggle = $(".nav-toggle");
  const navLinks  = $(".nav-links");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => navLinks.classList.toggle("open"));
    navLinks.addEventListener("click", (e) => {
      if (e.target.tagName === "A") navLinks.classList.remove("open");
    });
  }

  /* ----------------------------------------------------- active nav highlight */
  const sections = $$("section[id]");
  const linkFor = (id) => $('.nav-links a[href="#' + id + '"]');
  if ("IntersectionObserver" in window && sections.length) {
    const navObs = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          const link = linkFor(en.target.id);
          if (!link) return;
          if (en.isIntersecting) {
            $$(".nav-links a").forEach((a) => a.classList.remove("active"));
            link.classList.add("active");
          }
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    sections.forEach((s) => navObs.observe(s));
  }

  /* ---------------------------------------------------------- scroll reveal */
  const reveals = $$(".reveal");
  if ("IntersectionObserver" in window && reveals.length && !reduced) {
    const revObs = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            obs.unobserve(en.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    reveals.forEach((r) => revObs.observe(r));
  } else {
    reveals.forEach((r) => r.classList.add("in"));
  }

  /* ----------------------------------------------------- copy-to-clipboard */
  $$(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".code, .worksheet");
      const pre = block && block.querySelector("pre");
      const text = btn.dataset.clip || (pre ? pre.innerText : "");
      const done = () => {
        const old = btn.textContent;
        btn.textContent = "copied ✓";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  });

  /* =====================================================================
     Pipeline — clickable stages
     ===================================================================== */
  const PIPE_DETAIL = {
    compile: {
      t: "COMPILE_VERIFIER — author then freeze the contract",
      d: "The agent finds the test/command you pointed at, or writes new verification, and emits a runnable ladder of rungs + a rubric. The contract is hashed and <b>frozen</b> — no later transition can rewrite it. This is the anti-reward-hacking core.",
      pills: ['<span class="pill violet">fuzzy / LLM</span>', '<span class="pill pass">→ contractHash</span>'],
    },
    gatea: {
      t: "Gate A — contract approval (once)",
      d: "A human approves the frozen contract before the loop starts. With <code>--autonomous</code> it is auto-accepted — but still frozen and logged loudly. Gate A is the only gate the flag moves.",
      pills: ['<span class="pill gate">human · once</span>', '<span class="pill neutral">or auto-accept</span>'],
    },
    run: {
      t: "RUN_AGENT — one headless turn",
      d: "The Driver spawns the chosen harness headlessly with the prompt, resuming the session id. Output is parsed tolerantly into a HarnessRunResult. The Workspace captures a tree hash before &amp; after for stuck-detection.",
      pills: ['<span class="pill neutral">harness adapter</span>', '<span class="pill neutral">+ diffHash</span>'],
    },
    ladder: {
      t: "Verifier ladder — deterministic before judge",
      d: "Rungs run cheapest-and-hardest-to-game first: exit codes / tests, then any LLM judge. The ladder short-circuits on the first deterministic fail (no judge call wasted) and is <b>fail-closed</b> — a grader that throws is a hard red, never a green.",
      pills: ['<span class="pill pass">exit codes</span>', '<span class="pill violet">LLM quorum</span>'],
    },
    gateb: {
      t: "Gate B — independent approver (veto-only)",
      d: "Runs <b>only</b> when the ladder passes. An independent agent sees goal + frozen rubric + diff + verdicts and can only <b>veto</b>, never promote a red. It defaults to reject on uncertainty.",
      pills: ['<span class="pill gate">every iteration</span>', '<span class="pill fail">veto-only</span>'],
    },
    decide: {
      t: "DECIDE — the pure truth table",
      d: "Zero-LLM. DONE needs <b>two keys</b> (ladder passes AND no veto). Otherwise apply the backstops: stuck → ABORTED, iteration cap → FAILED, else CONTINUE with feedback threaded into the next prompt.",
      pills: ['<span class="pill pass">two keys → DONE</span>', '<span class="pill neutral">else continue</span>'],
    },
    plan: {
      t: "PLAN — author then freeze the plan (--phased)",
      d: "A read-only planner seam (LLM, like the compiler) decomposes one big goal into an <b>ordered list of sub-goals</b>. The plan is hashed (<code>planHash</code>), logged, and <b>frozen</b> — no transition rewrites it. A planner error / unparseable / over-long plan is a typed FAILED (fail-closed).",
      pills: ['<span class="pill violet">fuzzy / LLM</span>', '<span class="pill pass">→ planHash</span>'],
    },
    plangate: {
      t: "Plan gate — the plan-level Gate A",
      d: "The frozen plan is presented for <b>approve / revise / reject</b>, exactly like Gate A. Re-planning is only this bounded, gated path (capped by <code>--max-gate-a-revisions</code>) — never an automatic “make it easier”. <code>--autonomous</code> auto-accepts, still frozen + logged.",
      pills: ['<span class="pill gate">human · once</span>', '<span class="pill neutral">or auto-accept</span>'],
    },
    phase: {
      t: "Phase contract — a normal frozen, two-key run",
      d: "Each sub-goal runs as its <b>own</b> frozen contract through the exact same COMPILE → Gate A → loop → DECIDE machine. <code>--generate</code> authors the phase's verification (steered by the sub-goal's intent/rubric).",
      pills: ['<span class="pill pass">frozen contract</span>', '<span class="pill neutral">reused machine</span>'],
    },
    checkpoint: {
      t: "CHECKPOINT — scope the next phase's diff",
      d: "Between phases the Driver takes an internal <b>tree snapshot</b> (no commit, no <code>HEAD</code>/branch move) and adopts it as the new diff baseline, so phase N's diff — and the approver's Gate-B input — excludes phase N-1's work. Recorded so <code>--resume</code> re-enters mid-plan.",
      pills: ['<span class="pill neutral">private snapshot</span>', '<span class="pill pass">small diffs</span>'],
    },
    accept: {
      t: "ACCEPT — cumulative contract on the original goal",
      d: "A final acceptance contract is authored against the <b>original</b> goal and verified end-to-end (prefer a deterministic full-suite/build rung — ungameable, runs on the whole tree). <b>The whole run is DONE only when this passes both keys</b>, so phases passing individually can't green a broken whole.",
      pills: ['<span class="pill pass">two keys → DONE</span>', '<span class="pill fail">or FAILED</span>'],
    },
  };

  const pipeDetail = $("#pipeline-detail");
  function showPipe(key) {
    const info = PIPE_DETAIL[key];
    if (!info || !pipeDetail) return;
    $$(".stage").forEach((s) => s.classList.toggle("active", s.dataset.stage === key));
    pipeDetail.innerHTML =
      "<h4>" + info.t + "</h4><p>" + info.d + "</p>" +
      '<div class="meta">' + info.pills.join("") + "</div>";
  }
  $$(".stage").forEach((s) =>
    s.addEventListener("click", () => showPipe(s.dataset.stage))
  );
  showPipe("compile");

  /* =====================================================================
     State machine — clickable nodes
     ===================================================================== */
  const FSM = {
    COMPILING:     { cmd: "COMPILE_VERIFIER", ev: "CONTRACT_COMPILED / COMPILE_FAILED", d: "Seed state — also re-entered on a Gate A 'revise'. Emits the compile command (carrying any human feedback); the agent authors and freezes the contract." },
    AWAIT_GATE_A:  { cmd: "REQUEST_GATE_A",   ev: "GATE_A_DECIDED", d: "Holds the frozen contract for the human (or --autonomous): approve → loop, reject → ABORTED, or give feedback to revise (re-compile, bounded by --max-gate-a-revisions)." },
    RUNNING_AGENT: { cmd: "RUN_AGENT",        ev: "AGENT_RAN", d: "One headless harness turn. On return, iteration++ and the pre/post diff hashes are recorded." },
    VERIFYING:     { cmd: "RUN_VERIFIER",     ev: "VERIFIED", d: "Runs the frozen ladder. A pass routes to Gate B; a fail goes straight to DECIDE (Gate B never runs)." },
    AWAIT_GATE_B:  { cmd: "REQUEST_GATE_B",   ev: "GATE_B_DECIDED", d: "Reached only on a passing ladder. The independent approver may veto. Then DECIDE." },
    DONE:          { cmd: "—",                ev: "(terminal)", d: "Two keys turned: the frozen verifier passed and the approver did not veto. Exit code 0." },
    FAILED:        { cmd: "—",                ev: "(terminal)", d: "Reached maxIterations without satisfying the contract, or compile failed before any contract froze." },
    ABORTED:       { cmd: "—",                ev: "(terminal)", d: "A stuck detector fired (no-diff, repeat-failure, oscillation, budget), or Gate A rejected the contract / exhausted its revise rounds." },
  };
  const fsmDetail = $("#fsm-detail");
  function showFsm(state) {
    const info = FSM[state];
    if (!info || !fsmDetail) return;
    $$(".fsm-node").forEach((n) => n.classList.toggle("active", n.dataset.state === state));
    fsmDetail.innerHTML =
      "<h4>" + state + "</h4><p>" + info.d + "</p>" +
      '<div class="meta">' +
        '<span class="pill neutral">command: ' + info.cmd + "</span>" +
        '<span class="pill pass">event: ' + info.ev + "</span>" +
      "</div>";
  }
  $$(".fsm-node").forEach((n) =>
    n.addEventListener("click", () => showFsm(n.dataset.state))
  );
  showFsm("RUNNING_AGENT");

  /* =====================================================================
     DECIDE truth table — toggles → live outcome (matches decide.ts order)
     ===================================================================== */
  const tgPass = $("#tg-pass"), tgVeto = $("#tg-veto"), tgStuck = $("#tg-stuck"), tgCap = $("#tg-cap");
  const vetoToggle = tgVeto && tgVeto.closest(".toggle");
  const outBox = $("#decide-outcome");

  function decide() {
    if (!outBox) return;
    const pass = tgPass && tgPass.checked;
    const veto = tgVeto && tgVeto.checked;
    const stuck = tgStuck && tgStuck.checked;
    const cap = tgCap && tgCap.checked;

    // Gate B runs only when the ladder passes (approval is null otherwise).
    if (vetoToggle) vetoToggle.classList.toggle("disabled", !pass);

    let kind, big, why, rule;
    if (pass && !veto) {
      kind = "done"; big = "DONE"; rule = 0;
      why = "Two independent keys turned — the frozen verifier passed and the approver did not veto.";
    } else if (stuck) {
      kind = "aborted"; big = "ABORTED"; rule = 1;
      why = "A stuck detector fired. Bail before the cap with an actionable reason.";
    } else if (cap) {
      kind = "failed"; big = "FAILED"; rule = 2;
      why = "Reached maxIterations without satisfying the contract.";
    } else if (!pass) {
      kind = "continue"; big = "CONTINUE"; rule = 3;
      why = "Ladder failed — feed the verifier detail back as the next prompt. (Gate B never ran.)";
    } else {
      kind = "continue"; big = "CONTINUE"; rule = 4;
      why = "Ladder passed but the approver vetoed — feed the veto reason back and iterate.";
    }

    outBox.className = "outcome " + kind;
    outBox.querySelector(".big").textContent = big;
    outBox.querySelector(".why").textContent = why;
    $$(".precedence li").forEach((li, i) => li.classList.toggle("hit", i === rule));
  }
  [tgPass, tgVeto, tgStuck, tgCap].forEach((t) => t && t.addEventListener("change", decide));
  decide();

  /* =====================================================================
     Verifier ladder — short-circuit demo
     ===================================================================== */
  const ladderRungs = $$("#ladder .rung");        // DOM order = execution order (top → bottom)
  const ladderNote  = $("#ladder-note");
  function setLadder(failIndex) {
    ladderRungs.forEach((r, i) => {
      r.classList.remove("passed", "failed", "skipped");
      const stat = r.querySelector(".rstat");
      if (failIndex === -1) {
        r.classList.add("passed");
        if (stat) stat.innerHTML = '<span class="pill pass">pass</span>';
      } else if (i < failIndex) {
        r.classList.add("passed");
        if (stat) stat.innerHTML = '<span class="pill pass">pass</span>';
      } else if (i === failIndex) {
        r.classList.add("failed");
        if (stat) stat.innerHTML = '<span class="pill fail">✗ fail</span>';
      } else {
        r.classList.add("skipped");
        if (stat) stat.innerHTML = '<span class="pill neutral">skipped</span>';
      }
    });
    if (ladderNote) {
      if (failIndex === -1) {
        ladderNote.innerHTML = "All rungs pass → verdict <b>pass</b>, confidence = min(rung confidences). The two keys can now be checked at Gate B.";
      } else {
        const judgeSkipped = ladderRungs.slice(failIndex + 1).some((r) => r.classList.contains("judge"));
        ladderNote.innerHTML = "First failing rung short-circuits → verdict <b>fail</b>. " +
          (judgeSkipped ? "No LLM judge call is spent. " : "") +
          "The detail is fed back as the next prompt; Gate B never runs.";
      }
    }
    $$(".ladder-ctrl .mini-btn").forEach((b) => b.classList.toggle("on", Number(b.dataset.fail) === failIndex));
  }
  $$(".ladder-ctrl .mini-btn").forEach((b) =>
    b.addEventListener("click", () => setLadder(Number(b.dataset.fail)))
  );
  if (ladderRungs.length) setLadder(-1);

  /* =====================================================================
     Harness comparison tabs
     ===================================================================== */
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $$(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + id));
    })
  );

  /* ----------------------------------------------------------- year stamp */
  const yr = $("#year");
  if (yr) yr.textContent = new Date().getFullYear();
})();
