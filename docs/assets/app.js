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
      d: "The agent finds the test/command you pointed at, or writes new verification, and emits a runnable ladder of rungs + a rubric. The contract is hashed and <b>frozen</b> — no later transition can rewrite it. This is the anti-reward-hacking core. <b>🔁 Retriable:</b> a correctable authoring miss (COMPILE_FAILED) is re-authored with the error fed back, up to <code>--max-compile-retries</code> (default 2).",
      pills: ['<span class="pill violet">fuzzy / LLM</span>', '<span class="pill pass">→ contractHash</span>', '<span class="pill neutral">🔁 retry ≤ --max-compile-retries</span>'],
    },
    seal: {
      t: "SEAL — lock the bar (once, before the loop)",
      d: "A human approves the frozen contract before the loop starts. With <code>--autonomous</code> it is auto-accepted — but still frozen and logged loudly. SEAL is the only gate the flag moves. <b>🔁 Retriable:</b> instead of approve/reject you can give free-text feedback to <b>revise</b> — goaly re-authors the contract and re-presents it, up to <code>--max-seal-revisions</code> (default 10).",
      pills: ['<span class="pill gate">human · once</span>', '<span class="pill neutral">or auto-accept</span>', '<span class="pill neutral">🔁 revise ≤ --max-seal-revisions</span>'],
    },
    prepare: {
      t: "Tools + setup + pre-flight — once, before iteration 1",
      d: "After SEAL and before the first agent turn, goaly first probes the frozen <b>requiredTools</b> manifest — the external programs the verification assumes on PATH (cargo, python, go…). A missing tool by DEFAULT is handed to the agent to install (goaly skips its own setup, which would only fail on the absent toolchain, and threads the install into the first prompt); <code>--install-missing-tools false</code> opts out with a typed <code>TOOLS_MISSING</code> abort. (The verify PATH is extended with the standard per-user install dirs so an agent-installed toolchain is actually visible.) Then a one-time <b>setup</b> command prepares the tree (e.g. <code>npm ci</code> — authored under <code>--generate</code>, overridable with <code>--setup-cmd</code>); a non-zero exit is a typed <code>SETUP_FAILED</code>. Finally goaly <b>pre-flights</b> the frozen deterministic checks once: a <b>language-agnostic</b> classification (one read-only LLM call) decides a <b>broken</b> frozen verification (can't compile/collect/run) → <code>CONTRACT_UNSOUND</code> abort <b>before any worker token is spent</b>, vs. an honest red (implementation missing) → proceed. It fails <i>open</i> on uncertainty so a false abort never blocks a legitimate run.",
      pills: ['<span class="pill neutral">tools + setup, once</span>', '<span class="pill fail">TOOLS_MISSING / SETUP_FAILED / CONTRACT_UNSOUND</span>'],
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
    signoff: {
      t: "SIGN-OFF — independent approver (veto-only)",
      d: "Runs <b>only</b> when the ladder passes. An independent agent sees goal + frozen rubric + diff + verdicts and can only <b>veto</b>, never promote a red. It defaults to reject on uncertainty. The second of the two keys for DONE.",
      pills: ['<span class="pill gate">every iteration</span>', '<span class="pill fail">veto-only</span>'],
    },
    decide: {
      t: "DECIDE — the pure truth table",
      d: "Zero-LLM. DONE needs <b>two keys</b> (ladder passes AND no veto). Otherwise apply the backstops: stuck → ABORTED, iteration cap → FAILED, else CONTINUE. Stuck has typed reasons — no-diff, <code>STUCK_REPEATED_FAILURE</code> (same verifier signature N×), oscillation, <code>STUCK_HARNESS_CRASH</code> (the agent CLI exited abnormally N× in a row — a harness/environment failure surfaced as such, not looped on), and budget. <b>🔁 Retriable:</b> a red iteration (ladder FAIL or SIGN-OFF veto) loops back to RUN_AGENT with the failure/veto threaded into the next prompt, up to <code>--max-iterations</code> (default 10) or until STUCK.",
      pills: ['<span class="pill pass">two keys → DONE</span>', '<span class="pill neutral">🔁 else loop ≤ --max-iterations</span>'],
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
        ladderNote.innerHTML = "All rungs pass → verdict <b>pass</b>, confidence = min(rung confidences). The two keys can now be checked at Sign-off.";
      } else {
        const judgeSkipped = ladderRungs.slice(failIndex + 1).some((r) => r.classList.contains("judge"));
        ladderNote.innerHTML = "First failing rung short-circuits → verdict <b>fail</b>. " +
          (judgeSkipped ? "No LLM judge call is spent. " : "") +
          "The detail is fed back as the next prompt; Sign-off never runs.";
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
