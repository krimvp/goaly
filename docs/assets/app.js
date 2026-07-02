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
      d: "The agent finds or writes the verification and emits a runnable check + rubric. It's hashed and <b>frozen</b> — no later step can rewrite it. The anti-reward-hacking core.",
      pills: ['<span class="pill pass">→ contractHash</span>'],
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
      d: "Spawn the chosen harness headlessly with the prompt, resuming the session. A transiently-CRASHED turn (a momentary rate-limit/network blip) is retried once with backoff before it can count toward the stuck-crash streak — retries absorb blips, stuck detection governs walls. With --candidates N (best-of-N) the Driver fans out N isolated worktree attempts, scores each against the SAME frozen ladder, and keeps the best one's tree — the reducer still sees exactly one winning run and never learns N existed.",
      pills: ['<span class="pill neutral">harness adapter</span>', '<span class="pill violet">--candidates N (best-of-N)</span>'],
    },
    ladder: {
      t: "Verify — deterministic first",
      d: "Checks run cheapest-and-hardest-to-game first (tests / exit codes before any LLM judge) and short-circuit on the first fail. Fail-closed.",
      pills: ['<span class="pill pass">exit codes</span>', '<span class="pill violet">LLM judge</span>'],
    },
    signoff: {
      t: "SIGN-OFF — veto-only",
      d: "Runs only on a green check. An independent reviewer can veto, never promote a red — the second key for DONE.",
      pills: ['<span class="pill fail">veto-only</span>'],
    },
    decide: {
      t: "DECIDE — pure truth table",
      d: "Zero-LLM. DONE needs two keys; otherwise loop back, or stop on STUCK / budget / iteration cap. A no-diff turn is excused when the run was cut short (timeout, crash, or truncated at its turn cap) — it gets another iteration instead of a premature stuck abort. When the checker itself can't RUN for N turns in a row — the verify command timed out or couldn't start, or the judge errored/overflowed — that's a typed CONTRACT_UNEVALUABLE: it says the work may be correct-but-unverified instead of blaming (and discarding) the tree. It keys only on facts goaly owns (no exit-code/error-string guessing) and is prevented at the source (the compiler authors offline verify commands). Still fail-closed: a could-not-evaluate is never a green.",
      pills: ['<span class="pill pass">two keys → DONE</span>'],
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
