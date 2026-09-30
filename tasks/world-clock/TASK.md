# World Clock

Create `/workspace/world-clock.html`, a polished, self-contained world clock intended for human visual review.

## Required experience

- Lead with a large analog clock showing the current time.
- Include distinct hour, minute, and second hands. Mark their rendered elements with `data-clock-hand="hour"`, `data-clock-hand="minute"`, and `data-clock-hand="second"`.
- Update the clock continuously so the displayed time changes at least once per second.
- Show useful current-time context for at least four clearly named world locations. Mark each visible location container with `data-world-location`.
- Mark the primary analog face with `data-clock-face`.
- Make the composition feel complete at both a 1200 by 800 desktop viewport and a 390 by 844 phone viewport.
- Treat typography, spacing, color, depth, motion, and small details as part of the submission. This is an art-direction test, not merely a clock implementation.

## File contract

- Submit exactly one UTF-8 file at `/workspace/world-clock.html`.
- Put all HTML, CSS, JavaScript, fonts, and imagery in that file.
- Do not use network requests, external URLs, external scripts or stylesheets, embedded pages, plugins, or forms.
- Inline CSS, inline JavaScript, SVG, Canvas, and data-URI images or fonts are allowed.
- Include a non-empty document title.
- Read the current time in JavaScript and schedule continuous updates with `setInterval`, `setTimeout`, or `requestAnimationFrame`.
- Rotate each marked hand with a CSS `transform`; rotation `0deg` must point to 12 o'clock. The offline browser checker samples the computed transforms against the current time and confirms that the second hand moves.
- Keep the file at or below 2 MiB.

The harness checks the file contract and self-containment. It does not assign an automatic artistic score. The page is embedded in a network-blocked sandbox inside the results report for human review and a separate 0 to 10 visual rating.
