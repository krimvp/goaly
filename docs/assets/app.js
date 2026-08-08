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
      t: "COMPILE — author & freeze",
      d: "The agent finds or writes the verification and emits a runnable check + rubric. It's hashed and <b>frozen</b> — no later step can rewrite it. Vacuous or un-runnable bars are refused at compile. Two guards run before the freeze, both ON by default: a <b>satisfiability critic</b> asks whether a CORRECT implementation could still FAIL this bar (the mirror of red-teaming — findings make the bar satisfiable, never easier), and a <b>positive control</b> answers the same question by execution — a throwaway reference implementation is run against the bar in a scratch copy, and a bar even that cannot green is refused and re-authored (--no-satisfiability-critic / --contract-dry-run false opt out). With --adversarial a red-team panel attacks the authored bar as well.",
      pills: ['<span class="pill pass">→ contractHash</span>', '<span class="pill violet">--contract-dry-run</span>', '<span class="pill violet">satisfiability critic</span>', '<span class="pill fail">--adversarial red-team</span>'],
    },
    seal: {
      t: "SEAL — lock the bar",
      d: "You approve the frozen contract once, before the loop. <code>--autonomous</code> auto-accepts it — still frozen, still logged.",
      pills: ['<span class="pill gate">once, before the loop</span>'],
    },
    prepare: {
      t: "Prepare — once",
      d: "Probe required tools, run setup, and pre-flight the checks — so an unsound contract aborts before any worker token is spent.",
      pills: ['<span class="pill neutral">tools + setup + pre-flight</span>'],
    },
    run: {
      t: "RUN_AGENT — one turn",
      d: "Spawn the chosen harness headlessly with the prompt, resuming the session. A transiently-crashed turn is retried once with backoff. With --candidates N the Driver fans out N isolated worktree attempts, scores each against the SAME frozen ladder, and keeps the best — the reducer never learns N existed.",
      pills: ['<span class="pill neutral">harness adapter</span>', '<span class="pill violet">--candidates N (best-of-N)</span>'],
    },
    ladder: {
      t: "Verify — deterministic first",
      d: "Checks run cheapest-and-hardest-to-game first (tests / exit codes before any LLM judge) and short-circuit on the first fail. Under --generate a built-in integrity guard is rung [0]: every file goaly authored must still match the hash frozen into the contract, so the ladder you approved at Seal is the ladder that runs. Fail-closed: a malformed grader is never a green. With --adversarial a refute-first skeptic panel runs last and can only fail a candidate green.",
      pills: ['<span class="pill pass">[0] integrity guard</span>', '<span class="pill pass">exit codes</span>', '<span class="pill violet">LLM judge</span>', '<span class="pill fail">--adversarial refuters</span>'],
    },
    signoff: {
      t: "SIGN-OFF — veto-only",
      d: "Runs only on a green check. An independent reviewer can veto, never promote a red — the second key for DONE. Independence is wired, not assumed: the approver does not inherit the agent's --model where the provider offers another one, and a run whose agent, judge rung and approver still collapse onto one model is labelled SELF-JUDGED (degraded) in the run header, the terminal summary and `goaly runs show`.",
      pills: ['<span class="pill fail">veto-only</span>', '<span class="pill violet">--approver-model</span>'],
    },
    decide: {
      t: "DECIDE — pure truth table",
      d: "Zero-LLM. DONE needs two keys; otherwise loop back, or stop with a typed reason on STUCK / budget / iteration cap. A no-diff turn is excused when the run was cut short — but only once: repeated timeout-with-no-diff turns stop the run as STUCK_TIMEOUT_NO_DIFF instead of burning the iteration budget. A checker that itself can't run is a CONTRACT_UNEVALUABLE — correct-but-unverified, never blamed on the tree, never a green. And a repeat-failure streak that keeps tripping a FROZEN authored check takes one detour first: DECIDE emits ADJUDICATE_CONTRACT, the Driver makes ONE read-only call (the reducer stays pure), and an unsatisfiable bar aborts as CONTRACT_DEFECTIVE — your tree may be correct, so keep it, and the abort prints the successor command (--from-run <id> --recontract) that re-authors the bar and freezes a NEW contract under a NEW run id. Anything less than a confident verdict keeps today's abort, byte for byte.",
      pills: ['<span class="pill pass">two keys → DONE</span>', '<span class="pill fail">CONTRACT_DEFECTIVE</span>'],
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

  /* ----------------------------------------------------------- year stamp */
  const yr = $("#year");
  if (yr) yr.textContent = new Date().getFullYear();
})();
