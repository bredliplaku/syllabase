/* The cat companion: the university's mascot, a black-and-white cat (white body, a black cap
   over the ears and one eye, a black saddle and tail, pink nose, yellow-green eyes), drawn in
   SVG and kept alive.

   It is always in one of a few states, a random one on each visit, and moves between them on
   its own: sitting, a loaf, lying like a sphinx, asleep curled up, "making biscuits"
   (kneading, eyes shut, purring), squeezed into a cardboard box, rolled on its back with its
   paws in the air, or sitting with its back to you. Waking up comes with a big stretch.
   While awake it looks around, twitches its ears, flicks its tail, yawns, washes a paw,
   slow-blinks a heart, nods off, tilts its head, bleps, winks and watches the butterfly that
   sometimes flutters past. It has some attitude too: a side-eye, a smug look, a "hmph" with
   its nose in the air, and now and then it pats a mug off the edge while looking right at
   you. In the box it ducks down and peeks out; on its back it paddles its paws; turned away,
   it glances back over its shoulder. Asleep it dreams, twitches and sticks its tongue out.
   Its eyes follow the pointer when it comes close. The tail is a soft shape that waves all
   the time, and the whole cat breathes. A press makes it bounce (and wakes it up); pressed
   again and again, it gets a little sassy about it.

   Self-contained (its own styles), so it can be copied to another site as is. Any element
   with data-cat-mascot is filled when the page loads; CatMascot.mount(el) fills one later.
   The element sets the width (the drawing keeps a 260:190 shape). prefers-reduced-motion
   keeps it still. */
const CatMascot = (() => {
    const W = 260, H = 190;
    const INK = '#25252d';
    let count = 0;

    // ── States: how often each is the first one, how long it lasts (ms), what it does in the
    // meantime (with weights), and where it tends to go next ──
    const STATES = {
        sit: {
            weight: 3, stay: [25000, 60000],
            actions: {
                look: 2.4, ear: 2.4, flick: 1.6, yawn: 1.2, groom: 1.6, slowblink: 1.2, butterfly: 1.2,
                tilt: 1.4, blep: 1.2, sideeye: 1.2, smug: 1, wink: 0.7, hmph: 0.7, knock: 1.1,
            },
            next: { loaf: 2, lounge: 2, knead: 1.5, box: 1.3, belly: 0.9, turned: 0.6, sleep: 0.6 },
        },
        loaf: {
            weight: 2.5, stay: [25000, 55000],
            actions: { look: 3, ear: 3, yawn: 1.5, slowblink: 2, nod: 1.6, butterfly: 1, smug: 1.2, sideeye: 1, blep: 1 },
            next: { sleep: 2.2, sit: 2, knead: 1.2, lounge: 1, belly: 0.6 },
        },
        lounge: {
            weight: 2, stay: [25000, 55000],
            actions: { look: 3, ear: 3, flick: 2, yawn: 1.5, slowblink: 1.5, nod: 1, butterfly: 1.2, tilt: 1.2, blep: 1, sideeye: 1 },
            next: { sleep: 2, sit: 2, loaf: 1, belly: 1.2 },
        },
        knead: {
            weight: 1.6, stay: [12000, 22000],
            actions: { ear: 2, flick: 1.5 },
            next: { loaf: 2, sleep: 1.6, sit: 1 },
        },
        sleep: {
            weight: 2.2, stay: [30000, 75000],
            actions: { ear: 2, dream: 2, mlem: 1.4, tailtip: 2 },
            next: { sit: 2, loaf: 2, lounge: 1, belly: 0.8 },
        },
        box: {
            weight: 1.8, stay: [20000, 45000],
            actions: { look: 3, ear: 2, duck: 2.2, slowblink: 1.2, blep: 1.2, tilt: 1.2, sideeye: 1, butterfly: 1.2 },
            next: { sit: 2, loaf: 1, sleep: 0.5 },
        },
        belly: {
            weight: 1.4, stay: [15000, 35000],
            actions: { wiggle: 3, blep: 1.6, slowblink: 1.4, ear: 1.4, tailtip: 1.4, look: 1 },
            next: { lounge: 1.5, sleep: 1.5, sit: 1, loaf: 1 },
        },
        turned: {
            weight: 0.5, stay: [12000, 24000],
            actions: { glance: 4, ear: 2, flick: 2 },
            next: { sit: 3, loaf: 1 },
        },
    };
    const ACTION_MS = {
        look: 3000, ear: 700, flick: 1300, yawn: 2600, groom: 3600, slowblink: 2400, nod: 3200,
        butterfly: 6500, dream: 1700, mlem: 2600, tailtip: 1200, bounce: 700,
        tilt: 2800, blep: 3600, sideeye: 3400, smug: 3000, wink: 1600, hmph: 3800, knock: 4800,
        unamused: 2800, glance: 3600, duck: 3000, wiggle: 2400,
    };
    // Where a little attitude (after being pressed again and again) can show on the face.
    const SASSY = new Set(['sit', 'loaf', 'lounge', 'box', 'belly']);
    const STRETCH_MS = 2600;

    const STYLE = `
.cat-mascot { cursor: pointer; -webkit-tap-highlight-color: transparent; }
.cat-mascot svg { display: block; width: 100%; height: auto; aspect-ratio: ${W} / ${H}; overflow: visible; }
.cat-mascot .cm-pose { opacity: 0; visibility: hidden; transition: opacity 0.35s ease, visibility 0s linear 0.35s; }
.cat-mascot .cm-pose.is-on { opacity: 1; visibility: visible; transition: opacity 0.35s ease; }
.cat-mascot .cm-pose:not(.is-on) * { animation: none !important; }
.cat-mascot :is(.cm-pose, .cm-bounce, .cm-breathe, .cm-sway, .cm-head-idle, .cm-follow, .cm-head, .cm-ear, .cm-eye, .cm-gaze,
  .cm-look, .cm-yawn, .cm-tongue, .cm-blep, .cm-z, .cm-heart, .cm-raised, .cm-tuck, .cm-leg, .cm-purr, .cm-wing, .cm-whiskers,
  .cm-q, .cm-sparkle, .cm-swipe, .cm-cup, .cm-steam, .cm-limb, .cm-peek, .cm-box-paws) { transform-box: fill-box; }
.cat-mascot :is(.cm-pose, .cm-bounce, .cm-breathe, .cm-sway) { transform-origin: 50% 100%; }
.cat-mascot :is(.cm-head-idle, .cm-follow, .cm-head) { transform-origin: 50% 85%; }
.cat-mascot .cm-ear { transform-origin: 50% 100%; }
.cat-mascot :is(.cm-eye, .cm-heart, .cm-z, .cm-whiskers, .cm-q, .cm-sparkle) { transform-origin: center; }
.cat-mascot :is(.cm-yawn, .cm-tongue, .cm-blep) { transform-origin: 50% 0; }
.cat-mascot :is(.cm-leg, .cm-limb) { transform-origin: 50% 100%; }
.cat-mascot .cm-swipe { transform-origin: 100% 0; }
.cat-mascot .cm-cup { transform-origin: 0 100%; }
.cat-mascot .cm-wing-l { transform-origin: 100% 50%; }
.cat-mascot .cm-wing-r { transform-origin: 0% 50%; }
.cat-mascot .cm-yawn { transform: scale(0); }
.cat-mascot :is(.cm-tongue, .cm-blep) { transform: scaleY(0); }
.cat-mascot .cm-tail-whip { transform-box: view-box; transform-origin: var(--tail); }
.cat-mascot :is(.cm-closed, .cm-raised, .cm-z, .cm-heart, .cm-mouth-alt, .cm-wink, .cm-q, .cm-sparkle, .cm-swipe, .cm-cup, .cm-face) { opacity: 0; }
.cat-mascot .cm-gaze { transform: translate(calc(var(--gx, 0) * 1px), calc(var(--gy, 0) * 1px)); }
.cat-mascot .cm-follow { transform: rotate(calc(var(--gt, 0) * 5deg)); }
.cat-mascot .cm-ears-relaxed .cm-ear-l { transform: rotate(-8deg); }
.cat-mascot .cm-ears-relaxed .cm-ear-r { transform: rotate(8deg); }
/* Judging you: heavy lids, a flat mouth */
.cat-mascot .cm-judge .cm-lid { transform: translateY(12px); }
.cat-mascot .cm-judge .cm-mouth { opacity: 0; }
.cat-mascot .cm-judge .cm-mouth-flat { opacity: 1; }
.cat-mascot .cm-butterfly { opacity: 0; transition: opacity 0.6s ease; pointer-events: none; }
.cat-mascot .cm-butterfly.is-on { opacity: 1; }
.cat-mascot .cm-wing { animation: cm-flap 0.16s ease-in-out infinite alternate; }

/* Always: breathing, a gentle sway of the head, whiskers that move with the breath */
.cat-mascot .cm-breathe { animation: cm-breathe 3.6s ease-in-out infinite; }
.cat-mascot .cm-head-idle { animation: cm-head-idle 7.2s ease-in-out infinite; }
.cat-mascot .cm-whiskers { animation: cm-whisk 3.6s ease-in-out infinite; }
.cat-mascot .cm-pose-sleep .cm-breathe { animation: cm-breathe-deep 4.8s ease-in-out infinite; }
.cat-mascot .cm-pose-sleep .cm-head-idle { animation: cm-sleep-head 4.8s ease-in-out infinite; }
.cat-mascot .cm-pose-sleep .cm-z { animation: cm-z 3.6s ease-out infinite; }
.cat-mascot .cm-pose-sleep .cm-z2 { animation-delay: 1.2s; }
.cat-mascot .cm-pose-sleep .cm-z3 { animation-delay: 2.4s; }
/* Making biscuits: paws in turn, a sway, purring */
.cat-mascot .cm-pose-knead .cm-leg-l { animation: cm-knead 1.2s ease-in-out infinite; }
.cat-mascot .cm-pose-knead .cm-leg-r { animation: cm-knead 1.2s ease-in-out -0.6s infinite; }
.cat-mascot .cm-pose-knead .cm-sway { animation: cm-knead-sway 1.2s ease-in-out infinite; }
.cat-mascot .cm-pose-knead .cm-purr { animation: cm-purr 0.6s ease-in-out infinite alternate; }
.cat-mascot .cm-pose-knead .cm-head-idle { animation: cm-knead-head 2.4s ease-in-out infinite; }
/* On its back: the paws in the air drift on their own */
.cat-mascot .cm-pose-belly .cm-limb { animation: cm-limb-idle 3.2s ease-in-out infinite; }
.cat-mascot .cm-pose-belly :is(.cm-limb-2, .cm-limb-4) { animation-delay: -1.6s; }
/* The stretch on waking */
.cat-mascot .cm-pose-stretch.is-on .cm-yawn { animation: cm-yawn ${STRETCH_MS}ms ease-in-out; }
.cat-mascot .cm-pose-stretch.is-on .cm-sway { animation: cm-stretch ${STRETCH_MS}ms ease-in-out; }
.cat-mascot .cm-pose.is-entering { animation: cm-settle 0.6s cubic-bezier(.3, 1.5, .5, 1); }

.cat-mascot.cm-act-look .cm-look { animation: cm-look 3s ease-in-out; }
.cat-mascot.cm-act-look .cm-head { animation: cm-look-head 3s ease-in-out; }
.cat-mascot.cm-act-ear .cm-ear-r { animation: cm-ear 0.7s ease-in-out; }
.cat-mascot.cm-act-flick .cm-tail-whip { animation: cm-flick 1.3s ease-in-out; }
.cat-mascot.cm-act-tailtip .cm-tail-whip { animation: cm-tailtip 1.2s ease-in-out; }

.cat-mascot.cm-act-yawn .cm-head { animation: cm-yawn-head 2.6s ease-in-out; }
.cat-mascot.cm-act-yawn .cm-yawn { animation: cm-yawn 2.6s ease-in-out; }
.cat-mascot.cm-act-yawn .cm-mouth { animation: cm-hide 2.6s ease-in-out; }
.cat-mascot.cm-act-yawn .cm-lid { animation: cm-lid-yawn 2.6s ease-in-out; }
.cat-mascot.cm-act-yawn .cm-eye { animation: cm-eye-yawn 2.6s ease-in-out; }
.cat-mascot.cm-act-yawn .cm-closed { animation: cm-closed-yawn 2.6s ease-in-out; }
.cat-mascot.cm-act-yawn .cm-ear-l { animation: cm-ear-out-l 2.6s ease-in-out; }
.cat-mascot.cm-act-yawn .cm-ear-r { animation: cm-ear-out-r 2.6s ease-in-out; }

.cat-mascot.cm-act-groom .cm-tuck { animation: cm-tuck 3.6s ease-in-out; }
.cat-mascot.cm-act-groom .cm-raised { animation: cm-groom-paw 3.6s ease-in-out; }
.cat-mascot.cm-act-groom .cm-head { animation: cm-groom-head 3.6s ease-in-out; }
.cat-mascot.cm-act-groom .cm-tongue { animation: cm-lick 3.6s ease-in-out; }
.cat-mascot.cm-act-groom .cm-lid { animation: cm-lid-half 3.6s ease-in-out; }

.cat-mascot.cm-act-nod .cm-head { animation: cm-nod 3.2s ease-in-out; }
.cat-mascot.cm-act-nod .cm-lid { animation: cm-lid-nod 3.2s ease-in-out; }

.cat-mascot.cm-act-slowblink .cm-lid { animation: cm-lid-blink 2.4s ease-in-out; }
.cat-mascot.cm-act-slowblink .cm-eye { animation: cm-eye-blink 2.4s ease-in-out; }
.cat-mascot.cm-act-slowblink .cm-closed { animation: cm-closed-blink 2.4s ease-in-out; }
.cat-mascot.cm-act-slowblink .cm-heart { animation: cm-heart 2.4s ease-out; }

.cat-mascot.cm-act-butterfly .cm-ear-l { animation: cm-perk-l 6.5s ease-in-out; }
.cat-mascot.cm-act-butterfly .cm-ear-r { animation: cm-perk-r 6.5s ease-in-out; }

.cat-mascot.cm-act-dream .cm-tuck { animation: cm-dream 1.7s ease-in-out; }
.cat-mascot.cm-act-dream .cm-whiskers { animation: cm-dream-whisk 1.7s ease-in-out; }
.cat-mascot.cm-act-mlem .cm-tongue { animation: cm-mlem 2.6s ease-in-out; }

/* Curious: a head tilt and a question mark */
.cat-mascot.cm-act-tilt .cm-head { animation: cm-tilt 2.8s ease-in-out; }
.cat-mascot.cm-act-tilt .cm-ear-l { animation: cm-perk-l 2.8s ease-in-out; }
.cat-mascot.cm-act-tilt .cm-q { animation: cm-q 2.8s ease-out; }
/* Blep: the tip of the tongue out, nothing else */
.cat-mascot.cm-act-blep .cm-blep { animation: cm-blep 3.6s ease-in-out; }
/* Side-eye: heavy lids, the eyes to one side, a flat mouth */
.cat-mascot.cm-act-sideeye .cm-lid { animation: cm-lid-half 3.4s ease-in-out; }
.cat-mascot.cm-act-sideeye .cm-look { animation: cm-side 3.4s ease-in-out; }
.cat-mascot.cm-act-sideeye .cm-head { animation: cm-side-head 3.4s ease-in-out; }
.cat-mascot.cm-act-sideeye .cm-mouth { animation: cm-hide 3.4s ease-in-out; }
.cat-mascot.cm-act-sideeye .cm-mouth-flat { animation: cm-show 3.4s ease-in-out; }
/* Smug: half-shut eyes, a smirk, the chin up */
.cat-mascot.cm-act-smug .cm-lid { animation: cm-lid-smug 3s ease-in-out; }
.cat-mascot.cm-act-smug .cm-head { animation: cm-smug-head 3s ease-in-out; }
.cat-mascot.cm-act-smug .cm-mouth { animation: cm-hide 3s ease-in-out; }
.cat-mascot.cm-act-smug .cm-mouth-smirk { animation: cm-show 3s ease-in-out; }
/* A wink with a sparkle */
.cat-mascot.cm-act-wink .cm-eye-l { animation: cm-wink-eye 1.6s ease-in-out; }
.cat-mascot.cm-act-wink .cm-eye-l .cm-lid { animation: cm-lid-wink 1.6s ease-in-out; }
.cat-mascot.cm-act-wink .cm-wink { animation: cm-wink 1.6s ease-in-out; }
.cat-mascot.cm-act-wink .cm-sparkle { animation: cm-sparkle 1.6s ease-out; }
.cat-mascot.cm-act-wink .cm-head { animation: cm-wink-head 1.6s ease-in-out; }
/* Hmph: nose in the air, eyes shut, then one eye opens a crack to check you are watching */
.cat-mascot.cm-act-hmph .cm-head { animation: cm-hmph-head 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-eye-r { animation: cm-hmph-shut 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-closed-r { animation: cm-hmph-closed 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-eye-l { animation: cm-hmph-peek 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-closed-l { animation: cm-hmph-closed-peek 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-lid { animation: cm-lid-hmph 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-mouth { animation: cm-hide 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-mouth-flat { animation: cm-show 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-ear-l { animation: cm-ear-out-l 3.8s ease-in-out; }
.cat-mascot.cm-act-hmph .cm-ear-r { animation: cm-ear-out-r 3.8s ease-in-out; }
/* Unamused (pressed once too often): ears out, lids down, the tail thumps */
.cat-mascot.cm-act-unamused .cm-lid { animation: cm-lid-half 2.8s ease-in-out; }
.cat-mascot.cm-act-unamused .cm-ear-l { animation: cm-ear-out-l 2.8s ease-in-out; }
.cat-mascot.cm-act-unamused .cm-ear-r { animation: cm-ear-out-r 2.8s ease-in-out; }
.cat-mascot.cm-act-unamused .cm-mouth { animation: cm-hide 2.8s ease-in-out; }
.cat-mascot.cm-act-unamused .cm-mouth-flat { animation: cm-show 2.8s ease-in-out; }
.cat-mascot.cm-act-unamused .cm-tail-whip { animation: cm-flick 1.3s ease-in-out 2; }
/* The mug: noticed, patted twice, a long look at you, and off it goes */
.cat-mascot.cm-act-knock .cm-cup { animation: cm-cup 4.8s ease-in-out; }
.cat-mascot.cm-act-knock .cm-steam { animation: cm-steam 1.2s ease-in-out infinite; }
.cat-mascot.cm-act-knock .cm-swipe { animation: cm-swipe 4.8s ease-in-out; }
.cat-mascot.cm-act-knock .cm-tuck { animation: cm-reach 4.8s ease-in-out; }
.cat-mascot.cm-act-knock .cm-head { animation: cm-knock-head 4.8s ease-in-out; }
.cat-mascot.cm-act-knock .cm-lid { animation: cm-knock-lid 4.8s ease-in-out; }
.cat-mascot.cm-act-knock .cm-mouth { animation: cm-knock-mouth 4.8s ease-in-out; }
.cat-mascot.cm-act-knock .cm-mouth-smirk { animation: cm-knock-smirk 4.8s ease-in-out; }
/* Turned away: a look back over the shoulder */
.cat-mascot.cm-act-glance .cm-face { animation: cm-show 3.6s ease-in-out; }
.cat-mascot.cm-act-glance .cm-backhead { animation: cm-hide 3.6s ease-in-out; }
/* In the box: down out of sight, then the eyes over the edge, then back up */
.cat-mascot.cm-act-duck .cm-peek { animation: cm-duck 3s ease-in-out; }
.cat-mascot.cm-act-duck .cm-box-paws { animation: cm-letgo 3s ease-in-out; }
/* On its back: paddling paws; pressed, the paws close in (a trap) */
.cat-mascot.cm-act-wiggle .cm-limb { animation: cm-paddle 0.6s ease-in-out 4 alternate; }
.cat-mascot.cm-act-wiggle :is(.cm-limb-2, .cm-limb-4) { animation-delay: -0.3s; }
.cat-mascot.cm-act-bounce .cm-pose-belly :is(.cm-limb-1, .cm-limb-3) { animation: cm-grab-l 0.7s ease-out; }
.cat-mascot.cm-act-bounce .cm-pose-belly :is(.cm-limb-2, .cm-limb-4) { animation: cm-grab-r 0.7s ease-out; }

.cat-mascot.cm-act-bounce .cm-bounce { animation: cm-bounce 0.7s cubic-bezier(.3, 1.4, .5, 1); }
.cat-mascot.cm-act-bounce .cm-ear-l { animation: cm-perk-l 0.8s ease-out; }
.cat-mascot.cm-act-bounce .cm-ear-r { animation: cm-perk-r 0.8s ease-out; }

@keyframes cm-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.012, 1.022); } }
@keyframes cm-breathe-deep { 0%, 100% { transform: scale(1, 1); } 45% { transform: scale(1.018, 1.045); } }
@keyframes cm-head-idle { 0%, 100% { transform: rotate(0) translateY(0); } 25% { transform: rotate(1.6deg) translateY(-1.3px); }
  50% { transform: rotate(0) translateY(0); } 75% { transform: rotate(-1.6deg) translateY(-1.3px); } }
@keyframes cm-sleep-head { 0%, 100% { transform: translateY(0); } 45% { transform: translateY(-1.6px) rotate(-1deg); } }
@keyframes cm-whisk { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.03, 0.97); } }
@keyframes cm-settle { 0% { transform: scale(0.94, 1.06); } 45% { transform: scale(1.04, 0.96); } 100% { transform: scale(1, 1); } }
@keyframes cm-flap { from { transform: scaleX(1); } to { transform: scaleX(0.25); } }
@keyframes cm-z { 0% { opacity: 0; transform: translate(0, 0) scale(0.5); } 20% { opacity: 1; } 100% { opacity: 0; transform: translate(16px, -30px) scale(1.2); } }
@keyframes cm-knead { 0%, 100% { transform: translateY(0) scale(1.08, 0.94); } 30% { transform: translateY(-9px) scale(1, 1); }
  55% { transform: translateY(-9px) scale(1, 1); } 85% { transform: translateY(0) scale(1.1, 0.92); } }
@keyframes cm-knead-sway { 0%, 100% { transform: rotate(-1.2deg); } 50% { transform: rotate(1.2deg); } }
@keyframes cm-knead-head { 0%, 100% { transform: rotate(-2deg) translateY(0); } 50% { transform: rotate(2deg) translateY(-1px); } }
@keyframes cm-purr { from { opacity: 0.2; transform: translateX(0); } to { opacity: 0.9; transform: translateX(1px); } }
@keyframes cm-limb-idle { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(4deg); } }
@keyframes cm-stretch { 0% { transform: scale(1, 0.94); } 30%, 70% { transform: scale(1.05, 1.02); } 100% { transform: scale(1, 1); } }
@keyframes cm-look { 0%, 100% { transform: translateX(0); } 12%, 40% { transform: translateX(-3px); } 55%, 85% { transform: translateX(3px); } }
@keyframes cm-look-head { 0%, 100% { transform: rotate(0); } 12%, 40% { transform: rotate(-6deg); } 55%, 85% { transform: rotate(6deg); } }
@keyframes cm-ear { 0%, 100% { transform: rotate(0); } 20% { transform: rotate(16deg); } 40% { transform: rotate(-3deg); } 60% { transform: rotate(12deg); } 80% { transform: rotate(0); } }
@keyframes cm-flick { 0%, 100% { transform: rotate(0); } 20% { transform: rotate(-14deg); } 45% { transform: rotate(10deg); } 70% { transform: rotate(-6deg); } }
@keyframes cm-tailtip { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-5deg); } 60% { transform: rotate(3deg); } }
@keyframes cm-yawn-head { 0%, 100% { transform: rotate(0) translateY(0); } 25%, 70% { transform: rotate(-4deg) translateY(-3px); } }
@keyframes cm-yawn { 0%, 100% { transform: scale(0); } 25%, 65% { transform: scale(1); } 45% { transform: scale(1.08, 1.12); } }
@keyframes cm-hide { 0%, 100% { opacity: 1; } 12%, 85% { opacity: 0; } }
@keyframes cm-show { 0%, 100% { opacity: 0; } 12%, 85% { opacity: 1; } }
@keyframes cm-ear-out-l { 0%, 100% { transform: rotate(0); } 20%, 80% { transform: rotate(-14deg); } }
@keyframes cm-ear-out-r { 0%, 100% { transform: rotate(0); } 20%, 80% { transform: rotate(14deg); } }
@keyframes cm-tuck { 0%, 100% { opacity: 1; transform: translateY(0); } 15%, 85% { opacity: 0; transform: translateY(-12px); } }
@keyframes cm-groom-paw {
  0%, 100% { opacity: 0; transform: translateY(34px); }
  16%, 84% { opacity: 1; transform: translateY(0); }
  27%, 47%, 67% { opacity: 1; transform: translateY(-3px); }
  37%, 57%, 77% { opacity: 1; transform: translateY(1px); } }
@keyframes cm-groom-head { 0%, 100% { transform: rotate(0) translateY(0); } 18%, 82% { transform: rotate(-8deg) translateY(4px); } }
@keyframes cm-lick { 0%, 22%, 32%, 42%, 52%, 62%, 72%, 100% { transform: scaleY(0); } 27%, 37%, 47%, 57%, 67% { transform: scaleY(1); } }
@keyframes cm-nod { 0%, 100% { transform: rotate(0) translateY(0); } 20%, 55% { transform: rotate(4deg) translateY(3px); }
  62% { transform: rotate(-2deg) translateY(-2px); } 75% { transform: rotate(0) translateY(0); } }
@keyframes cm-lid-nod { 0%, 100% { transform: translateY(0); } 20% { transform: translateY(10px); } 50%, 56% { transform: translateY(15px); } 61% { transform: translateY(0); } }
/* Eyes that close: the lid slides down to the middle, then the eye turns into a shut line
   (where the lid's edge is), and back */
@keyframes cm-lid-blink { 0% { transform: translateY(0); } 24%, 64% { transform: translateY(16px); } 90%, 100% { transform: translateY(0); } }
@keyframes cm-eye-blink { 0%, 24% { opacity: 1; } 25%, 63% { opacity: 0; } 64%, 100% { opacity: 1; } }
@keyframes cm-closed-blink { 0%, 24% { opacity: 0; } 25%, 63% { opacity: 1; } 64%, 100% { opacity: 0; } }
@keyframes cm-lid-yawn { 0% { transform: translateY(0); } 9%, 88% { transform: translateY(16px); } 100% { transform: translateY(0); } }
@keyframes cm-eye-yawn { 0%, 9% { opacity: 1; } 10%, 87% { opacity: 0; } 88%, 100% { opacity: 1; } }
@keyframes cm-closed-yawn { 0%, 9% { opacity: 0; } 10%, 87% { opacity: 1; } 88%, 100% { opacity: 0; } }
@keyframes cm-heart { 0%, 30% { opacity: 0; transform: translateY(0) scale(0.5); } 45% { opacity: 1; transform: translateY(-6px) scale(1); } 100% { opacity: 0; transform: translateY(-24px) scale(1.1); } }
@keyframes cm-perk-l { 0%, 100% { transform: rotate(0); } 15%, 80% { transform: rotate(8deg) translateY(-2px); } }
@keyframes cm-perk-r { 0%, 100% { transform: rotate(0); } 15%, 80% { transform: rotate(-8deg) translateY(-2px); } }
@keyframes cm-dream { 0%, 100% { transform: translateY(0); } 20%, 40%, 60% { transform: translateY(-2.5px); } 30%, 50% { transform: translateY(0.5px); } }
@keyframes cm-dream-whisk { 0%, 100% { transform: scale(1); } 25%, 55% { transform: scale(1.08, 0.9); } 40% { transform: scale(0.96, 1.05); } }
@keyframes cm-mlem { 0%, 100% { transform: scaleY(0); } 20%, 80% { transform: scaleY(0.75); } }
@keyframes cm-tilt { 0%, 100% { transform: rotate(0); } 16%, 76% { transform: rotate(13deg); } }
@keyframes cm-q { 0%, 16% { opacity: 0; transform: translateY(5px) scale(0.5); } 28%, 72% { opacity: 1; transform: translateY(0) scale(1); }
  90%, 100% { opacity: 0; transform: translateY(-6px) scale(1); } }
@keyframes cm-blep { 0%, 100% { transform: scaleY(0); } 12%, 84% { transform: scaleY(1); } }
@keyframes cm-lid-half { 0%, 100% { transform: translateY(0); } 14%, 84% { transform: translateY(11px); } }
@keyframes cm-lid-smug { 0%, 100% { transform: translateY(0); } 14%, 84% { transform: translateY(9px); } }
@keyframes cm-side { 0%, 100% { transform: translateX(0); } 18%, 80% { transform: translateX(4.4px); } }
@keyframes cm-side-head { 0%, 100% { transform: rotate(0); } 15%, 82% { transform: rotate(-5deg); } }
@keyframes cm-smug-head { 0%, 100% { transform: rotate(0) translateY(0); } 15%, 82% { transform: rotate(-4deg) translateY(-1.5px); } }
@keyframes cm-lid-wink { 0% { transform: translateY(0); } 11%, 76% { transform: translateY(16px); } 90%, 100% { transform: translateY(0); } }
@keyframes cm-wink-eye { 0%, 11% { opacity: 1; } 12%, 75% { opacity: 0; } 76%, 100% { opacity: 1; } }
@keyframes cm-wink { 0%, 11% { opacity: 0; } 12%, 75% { opacity: 1; } 76%, 100% { opacity: 0; } }
@keyframes cm-sparkle { 0%, 16% { opacity: 0; transform: scale(0.2) rotate(0); } 30% { opacity: 1; transform: scale(1.1) rotate(45deg); }
  60% { opacity: 1; transform: scale(0.9) rotate(70deg); } 80%, 100% { opacity: 0; transform: scale(0.4) rotate(90deg); } }
@keyframes cm-wink-head { 0%, 100% { transform: rotate(0); } 14%, 72% { transform: rotate(-6deg); } }
@keyframes cm-hmph-head { 0%, 100% { transform: rotate(0) translate(0, 0); } 12%, 82% { transform: rotate(-10deg) translate(-2px, -3px); } }
@keyframes cm-hmph-shut { 0%, 9% { opacity: 1; } 10%, 86% { opacity: 0; } 87%, 100% { opacity: 1; } }
@keyframes cm-hmph-closed { 0%, 9% { opacity: 0; } 10%, 86% { opacity: 1; } 87%, 100% { opacity: 0; } }
@keyframes cm-hmph-peek { 0%, 9% { opacity: 1; } 10%, 50% { opacity: 0; } 51%, 72% { opacity: 1; } 73%, 86% { opacity: 0; } 87%, 100% { opacity: 1; } }
@keyframes cm-hmph-closed-peek { 0%, 9% { opacity: 0; } 10%, 50% { opacity: 1; } 51%, 72% { opacity: 0; } 73%, 86% { opacity: 1; } 87%, 100% { opacity: 0; } }
@keyframes cm-lid-hmph { 0% { transform: translateY(0); } 9%, 50% { transform: translateY(16px); } 53%, 71% { transform: translateY(12.5px); } 73%, 87% { transform: translateY(16px); } 96%, 100% { transform: translateY(0); } }
@keyframes cm-cup { 0% { opacity: 0; transform: translate(0, 0) rotate(0); } 8% { opacity: 1; transform: translate(0, 0) rotate(0); }
  26% { transform: translate(0, 0) rotate(0); } 28% { transform: translate(-1px, 0) rotate(-4deg); } 31% { transform: translate(0, 0) rotate(0); }
  38% { transform: translate(0, 0) rotate(0); } 40% { transform: translate(-1px, 0) rotate(-4deg); } 43%, 62% { opacity: 1; transform: translate(0, 0) rotate(0); }
  67% { opacity: 1; transform: translate(-8px, 0) rotate(-6deg); } 72% { opacity: 1; transform: translate(-14px, 2px) rotate(-40deg); }
  86%, 100% { opacity: 0; transform: translate(-24px, 52px) rotate(-130deg); } }
@keyframes cm-steam { 0%, 100% { opacity: 0.3; transform: translateY(0); } 50% { opacity: 0.9; transform: translateY(-2px); } }
@keyframes cm-swipe { 0%, 14% { opacity: 0; transform: rotate(-30deg); } 20% { opacity: 1; transform: rotate(0); }
  24% { transform: rotate(7deg); } 28% { transform: rotate(0); } 36% { transform: rotate(7deg); } 40%, 60% { transform: rotate(0); }
  63% { transform: rotate(-3deg); } 68% { opacity: 1; transform: translateX(-8px) rotate(4deg); } 74% { opacity: 1; transform: translateX(-5px) rotate(2deg); }
  84%, 100% { opacity: 0; transform: rotate(-30deg); } }
@keyframes cm-reach { 0%, 100% { opacity: 1; } 15%, 84% { opacity: 0; } }
@keyframes cm-knock-head { 0%, 100% { transform: rotate(0) translateY(0); } 10%, 30% { transform: rotate(-7deg) translateY(2px); } 40%, 90% { transform: rotate(0) translateY(0); } }
@keyframes cm-knock-lid { 0%, 48% { transform: translateY(0); } 56%, 92% { transform: translateY(9px); } 100% { transform: translateY(0); } }
@keyframes cm-knock-mouth { 0%, 66%, 100% { opacity: 1; } 70%, 94% { opacity: 0; } }
@keyframes cm-knock-smirk { 0%, 66%, 100% { opacity: 0; } 70%, 94% { opacity: 1; } }
@keyframes cm-duck { 0%, 100% { transform: translateY(0); } 16%, 42% { transform: translateY(58px); } 54%, 74% { transform: translateY(15px); }
  86% { transform: translateY(-4px); } 93% { transform: translateY(0); } }
@keyframes cm-letgo { 0%, 100% { opacity: 1; } 8%, 88% { opacity: 0; } }
@keyframes cm-paddle { from { transform: rotate(-10deg); } to { transform: rotate(10deg); } }
@keyframes cm-grab-l { 0%, 100% { transform: rotate(0); } 25%, 60% { transform: rotate(18deg); } }
@keyframes cm-grab-r { 0%, 100% { transform: rotate(0); } 25%, 60% { transform: rotate(-18deg); } }
@keyframes cm-bounce { 0%, 100% { transform: translateY(0) scale(1, 1); } 12% { transform: translateY(0) scale(1.07, 0.9); }
  40% { transform: translateY(-12px) scale(0.95, 1.06); } 66% { transform: translateY(0) scale(1.05, 0.94); } 82% { transform: translateY(0) scale(0.99, 1.01); } }

@media (prefers-reduced-motion: reduce) {
  .cat-mascot * { animation: none !important; }
}`;

    function addStyle() {
        if (document.getElementById('cat-mascot-style')) return;
        const style = document.createElement('style');
        style.id = 'cat-mascot-style';
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    // ── Shapes ──
    const r1 = n => Math.round(n * 10) / 10;
    // A smooth curve through points (Catmull-Rom as cubic Béziers), without the first M.
    function through(points) {
        let d = '';
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
            d += ` C${r1(p1[0] + (p2[0] - p0[0]) / 6)} ${r1(p1[1] + (p2[1] - p0[1]) / 6)} ${r1(p2[0] - (p3[0] - p1[0]) / 6)} ${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${r1(p2[0])} ${r1(p2[1])}`;
        }
        return d;
    }
    // A tail: a soft band along a centre line, w0 wide at the base and w1 at the round tip.
    function ribbon(pts, w0, w1) {
        const n = pts.length, L = [], R = [];
        pts.forEach((p, i) => {
            const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
            let tx = b[0] - a[0], ty = b[1] - a[1];
            const len = Math.hypot(tx, ty) || 1;
            tx /= len; ty /= len;
            const w = (w0 + (w1 - w0) * i / (n - 1)) / 2;
            L.push([p[0] - ty * w, p[1] + tx * w]);
            R.push([p[0] + ty * w, p[1] - tx * w]);
        });
        const tip = r1(w1 / 2);
        return `M${r1(L[0][0])} ${r1(L[0][1])}${through(L)} A${tip} ${tip} 0 0 0 ${r1(R[n - 1][0])} ${r1(R[n - 1][1])}${through(R.reverse())} Z`;
    }
    // The centre line moved: the further along, the more (so the tip swings and the base stays).
    const swing = (pts, dx, dy) => pts.map(([x, y], i) => {
        const t = Math.pow(i / (pts.length - 1), 1.5);
        return [x + dx * t, y + dy * t];
    });
    // SMIL path keyframes, eased, looping.
    function morph(frames, seconds) {
        const loop = [...frames, frames[0]];
        const times = loop.map((_, i) => Math.round(i / (loop.length - 1) * 1000) / 1000).join(';');
        const splines = loop.slice(1).map(() => '0.45 0 0.55 1').join(';');
        return `<animate attributeName="d" dur="${seconds}s" repeatCount="indefinite" calcMode="spline" keyTimes="${times}" keySplines="${splines}" values="${loop.join(';')}"/>`;
    }
    // A path mirrored left to right round x = 0 (it must use only coordinate pairs: M, C, L, Z).
    const mirror = d => d.replace(/(-?\d+(?:\.\d+)?)(\s+)(-?\d+(?:\.\d+)?)/g, (m, x, s, y) => `${r1(-parseFloat(x))}${s}${y}`);

    let id_ = ''; // the drawing's id prefix while it is built

    // A tail along a centre line, waving between the given swings, whipping (flick) from its base.
    function tail(pts, swings, seconds = 4.2, w0 = 14, w1 = 10.5) {
        const frames = [pts, ...swings.map(([dx, dy]) => swing(pts, dx, dy))];
        const shapes = frames.map(f => ribbon(f, w0, w1));
        const sheen = frames.map(f => {
            const line = f.slice(1, -1).map(([x, y]) => [x - 1.5, y - 2]);
            return `M${r1(line[0][0])} ${r1(line[0][1])}${through(line)}`;
        });
        return `<g class="cm-tail-whip" style="--tail: ${pts[0][0]}px ${pts[0][1]}px">
        <path d="${shapes[0]}" fill="url(#${id_}-black)" filter="url(#${id_}-ink)">${morph(shapes, seconds)}</path>
        <path d="${sheen[0]}" fill="none" stroke="#6a6d7c" stroke-width="1.6" stroke-linecap="round" opacity="0.55">${morph(sheen, seconds)}</path>
      </g>`;
    }
    // A front paw on the ground: a small soft mitten, round on top and a little flatter below,
    // with a thin outline and two toe lines. s scales it.
    const paw = (cx, cy, s = 1) => {
        const w = 8.2 * s, h = 6.2 * s, at = (dx, dy) => `${r1(cx + dx * w)} ${r1(cy + dy * h)}`;
        const toes = [-0.34, 0.34].map(f => `M${at(f, 0.78)} L${at(f * 1.06, 0.32)}`).join(' ');
        return `<path d="M${at(-1, 0.25)} C${at(-1, -1.3)} ${at(1, -1.3)} ${at(1, 0.25)} C${at(1, 1.05)} ${at(-1, 1.05)} ${at(-1, 0.25)} Z" fill="url(#${id_}-paw)" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`
            + `<path d="${toes}" stroke="${INK}" stroke-width="1.1" stroke-linecap="round" opacity="0.55"/>`
            + `<path d="M${at(-0.45, -0.55)} Q${at(0, -0.85)} ${at(0.45, -0.55)}" stroke="#ffffff" stroke-width="1.3" fill="none" stroke-linecap="round" opacity="0.9"/>`;
    };
    const beans = (cx, cy, s = 1) => `<g fill="#f3a3b5"><ellipse cx="${cx}" cy="${r1(cy + 2.6 * s)}" rx="${r1(3.6 * s)}" ry="${r1(2.8 * s)}"/>`
        + [-5.6, -1.8, 1.8, 5.6].map((dx, i) => `<circle cx="${r1(cx + dx * s)}" cy="${r1(cy + (i === 0 || i === 3 ? -2.6 : -4.2) * s)}" r="${r1(1.6 * s)}"/>`).join('') + '</g>';
    // A paw held up, its soft side out: a round pad with pink beans, turned by rot degrees.
    const pawUp = (cx, cy, rot = 0, s = 1) => `<g transform="rotate(${rot} ${cx} ${cy})">
        <ellipse cx="${cx}" cy="${cy}" rx="${r1(8 * s)}" ry="${r1(7.2 * s)}" fill="url(#${id_}-paw)" stroke="${INK}" stroke-width="1.4"/>
        ${beans(cx, r1(cy + 0.4 * s), 0.78 * s)}</g>`;
    // A leg: a tapered band along points (shoulder to wrist), w0 to w1 wide, finely inked.
    const limb = (pts, w0, w1) => `<path d="${ribbon(pts, w0, w1)}" fill="url(#${id_}-white)" filter="url(#${id_}-ink-fine)"/>`;
    const shadow = (cx, cy, rx) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="6.5" fill="#000" opacity="0.15" filter="url(#${id_}-soft)"/>`;
    // Inner lines: fur, folds and contours, thinner than the outline.
    const fur = (d, width = 1.3, colour = '#cdd0de') => `<path d="${d}" stroke="${colour}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    const contour = d => `<path d="${d}" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round" opacity="0.6"/>`;

    // ── The head, drawn round (0, 0): ears to y -53, chin at y 32.5 ──
    // The black cap covers the ears, the top and the cat's left eye down to the cheek, with a
    // white blaze up between the eyes; the other eye has black only above it.
    const HEAD = 'M0 -34 C23 -34 38 -22 40 -5 Q45 -2 47.5 2.5 Q42 4.5 41 5.5 Q46.5 9.5 45.5 14.5 Q40 14.5 36.5 16.5 '
        + 'C30 27.5 15.5 32.5 0 32.5 C-15.5 32.5 -30 27.5 -36.5 16.5 Q-40 14.5 -45.5 14.5 Q-46.5 9.5 -41 5.5 '
        + 'Q-42 4.5 -47.5 2.5 Q-45 -2 -40 -5 C-38 -22 -23 -34 0 -34 Z';
    const CAP = 'M-52 -58 H52 V12 C43 17.5 30 16.5 21.5 12 C13 7.5 8.5 -1.5 6 -12.5 C4 -19.5 2 -27 0 -32 '
        + 'C-2 -27 -4 -19.5 -6.3 -14.5 C-9.5 -8.5 -16.5 -10 -24.5 -11.5 C-32.5 -13 -41 -9.5 -52 -6 Z';
    const EAR_L = 'M-35 -13 C-40 -30 -37 -46 -31 -53 C-21.5 -48.5 -13 -40 -8 -30 Z';
    const EAR_L_IN = 'M-30 -21 C-32.5 -31.5 -31.5 -41 -29 -46 C-23.5 -42 -18.5 -36 -15 -30 Z';
    const EYE = { rx: 10.2, ry: 10.8, cy: -1 };

    // An eye: a big round pupil with two highlights (cute), and a lid that slides down for the
    // judging looks, cut to the eye's shape and coloured like the fur round it.
    function eye(side, cx) {
        const id = id_;
        const lidFill = side === 'l' ? '#f6f6fa' : '#2c2d35';
        return `<g class="cm-eye cm-eye-${side}">
          <ellipse cx="${cx}" cy="${EYE.cy}" rx="${EYE.rx}" ry="${EYE.ry}" fill="url(#${id}-iris)"/>
          <ellipse cx="${cx}" cy="${EYE.cy}" rx="8.6" ry="9.2" fill="none" stroke="#7f8f22" stroke-width="1" opacity="0.4"/>
          <g class="cm-gaze"><g class="cm-look">
            <ellipse cx="${cx}" cy="0" rx="5.6" ry="7.4" fill="#121216"/>
            <circle cx="${r1(cx - 3)}" cy="-4.4" r="3.4" fill="#ffffff"/>
            <circle cx="${r1(cx + 3)}" cy="3.6" r="1.6" fill="#ffffff" opacity="0.9"/>
          </g></g>
          <path d="M${r1(cx - 7)} 5.2 Q${cx} 10.6 ${r1(cx + 7)} 5.2" stroke="#ffffff" stroke-width="1.2" fill="none" opacity="0.35" stroke-linecap="round"/>
          <g clip-path="url(#${id}-eye-${side})"><g class="cm-lid">
            <path d="M${r1(cx - 12)} -44 H${r1(cx + 12)} V-15 Q${cx} -11.5 ${r1(cx - 12)} -15 Z" fill="${lidFill}"/>
            <path d="M${r1(cx - 12)} -15 Q${cx} -11.5 ${r1(cx + 12)} -15" stroke="#18181d" stroke-width="2" fill="none"/>
          </g></g>
          <ellipse cx="${cx}" cy="${EYE.cy}" rx="${EYE.rx}" ry="${EYE.ry}" fill="none" stroke="#18181d" stroke-width="1.4"/>
          <path d="M${r1(cx - 10.8)} -3 C${r1(cx - 8.4)} -12.6 ${r1(cx + 8.4)} -13.1 ${r1(cx + 10.8)} -3.5 ${side === 'l' ? 'l-1 -2.4' : 'l1 -2.4'}" stroke="#18181d" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </g>`;
    }

    // The head; mode: 'open' (eyes that close with a lid, look, follow and pull faces), 'happy' (shut,
    // smiling, for kneading), 'sleep' (shut, relaxed ears) or 'squeeze' (screwed shut, mouth
    // wide: stretching). judge: lids down and a flat mouth, all the time.
    function head(x, y, { rotate = 0, scale = 1, mode = 'open', judge = false } = {}) {
        const id = id_;
        const shutL = 'M-24 -0.5 Q-15.5 6.5 -7 -0.5', shutR = 'M7 -0.5 Q15.5 6.5 24 -0.5';
        const line = (d, colour, w = 2.2) => `<path d="${d}" stroke="${colour}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        let eyes;
        if (mode === 'open') eyes = `${eye('l', -15.5)}${eye('r', 15.5)}
          <g class="cm-closed cm-closed-l">${line(shutL, '#18181d')}</g>
          <g class="cm-closed cm-closed-r">${line(shutR, '#c3c6d4')}</g>
          <g class="cm-wink">${line('M-24 2 Q-15.5 -6.5 -7 2', '#18181d', 2.4)}</g>`;
        else if (mode === 'happy') eyes = `${line('M-24 2.5 Q-15.5 -6.5 -7 2.5', '#18181d', 2.4)}${line('M7 2.5 Q15.5 -6.5 24 2.5', '#c3c6d4', 2.4)}`;
        else if (mode === 'sleep') eyes = `${line(shutL, '#18181d')}${line('M-22 3.4 l-2.2 2.4 M-18.5 4.8 l-1.2 2.8', '#18181d', 1.2)}${line(shutR, '#c3c6d4')}`;
        else eyes = `${line('M-23 -5 L-9 -0.5 L-23 4', '#18181d', 2.3)}${line('M23 -5 L9 -0.5 L23 4', '#c3c6d4', 2.3)}`;
        const mouth = (cls, d) => `<path class="${cls}" d="${d}" stroke="#3a2f35" stroke-width="1.35" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        return `<g transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale})">
      <g class="cm-head-idle"><g class="cm-follow"><g class="cm-head${mode === 'sleep' ? ' cm-ears-relaxed' : ''}${judge ? ' cm-judge' : ''}">
        <g class="cm-ear cm-ear-l"><g filter="url(#${id}-ink)">
          <path d="${EAR_L}" fill="url(#${id}-black)"/><path d="${EAR_L_IN}" fill="url(#${id}-ear)"/></g>
          ${fur('M-27.5 -23 q-0.5 -5 2.5 -9 M-24 -24.5 q0 -5 4 -8 M-20.5 -26.5 q0.5 -3.5 3.5 -5.5', 1.1, '#ffffff')}
        </g>
        <g class="cm-ear cm-ear-r"><g filter="url(#${id}-ink)">
          <path d="${mirror(EAR_L)}" fill="url(#${id}-black)"/><path d="${mirror(EAR_L_IN)}" fill="url(#${id}-ear)"/></g>
          ${fur('M27.5 -23 q0.5 -5 -2.5 -9 M24 -24.5 q0 -5 -4 -8 M20.5 -26.5 q-0.5 -3.5 -3.5 -5.5', 1.1, '#ffffff')}
        </g>
        <g filter="url(#${id}-ink)">
          <path d="${HEAD}" fill="url(#${id}-face)"/>
          <g clip-path="url(#${id}-headclip)">
            <path d="${CAP}" fill="url(#${id}-black)"/>
            <ellipse cx="0" cy="30" rx="30" ry="8" fill="#dcdeea" opacity="0.8" filter="url(#${id}-blur)"/>
            <ellipse cx="-30" cy="-26" rx="16" ry="9" fill="#5a5d6b" opacity="0.45" filter="url(#${id}-blur)"/>
          </g>
        </g>
        ${fur('M-6 -27 q-3 4 -4 10 M6 -27 q3 4 4.5 10 M-15 -25 q-4 3 -7 8 M17 -24 q4 3 7 8', 1.2, '#535665')}
        ${fur('M-42 8.5 q4 1 6.5 -1.2 M-43.5 2.5 q4 0 6.5 -2.2 M-39 14.5 q3 1 5.5 -1 M-30 22 q3 0 5 -2', 1.2)}
        ${fur('M36 14.5 q3 1 5.5 -1 M30 22 q3 0 5 -2', 1.2, '#5a5d6b')}
        <ellipse cx="-26.5" cy="15.5" rx="6" ry="3.4" fill="#f5a3b6" opacity="0.5" filter="url(#${id}-fuzz)"/>
        <ellipse cx="27" cy="19.5" rx="5.4" ry="2.8" fill="#f5a3b6" opacity="0.5" filter="url(#${id}-fuzz)"/>
        ${eyes}
        <g class="cm-whiskers">
          ${fur('M-9 12.5 C-20 9.5 -30 8.5 -40 8 M-9 15 C-20 14.5 -30 15 -41 16.5 M-8.5 17.5 C-18 19.5 -27 22 -37 25.5', 0.95, '#a6a9b5')}
          ${fur('M9 12.5 C20 9.5 30 8.5 40 8 M9 15 C20 14.5 30 15 41 16.5 M8.5 17.5 C18 19.5 27 22 37 25.5', 0.95, '#b9bcc8')}
        </g>
        <ellipse cx="-4.6" cy="15.2" rx="5.4" ry="3.8" fill="#ffffff"/><ellipse cx="4.6" cy="15.2" rx="5.4" ry="3.8" fill="#ffffff"/>
        <g fill="#b9bcc8"><circle cx="-6.5" cy="14.2" r="0.6"/><circle cx="-4" cy="16.2" r="0.6"/><circle cx="-7.2" cy="16.8" r="0.6"/>
          <circle cx="6.5" cy="14.2" r="0.6"/><circle cx="4" cy="16.2" r="0.6"/><circle cx="7.2" cy="16.8" r="0.6"/></g>
        <path d="M-4.2 9.4 Q0 7.8 4.2 9.4 Q3 13.6 0 14.8 Q-3 13.6 -4.2 9.4 Z" fill="url(#${id}-nose)" stroke="#bf6478" stroke-width="0.7"/>
        <ellipse cx="-1.4" cy="9.9" rx="1.3" ry="0.65" fill="#ffffff" opacity="0.75"/>
        ${mouth('cm-mouth', 'M0 14.8 V16.6 M0 16.6 Q-3 20 -6.4 17.4 M0 16.6 Q3 20 6.4 17.4')}
        ${mouth('cm-mouth-alt cm-mouth-flat', 'M0 14.8 V17.2 M-5.4 18.8 Q0 16.9 5.4 18.8')}
        ${mouth('cm-mouth-alt cm-mouth-smirk', 'M0 14.8 V16.6 M0 16.6 Q-3 19.4 -6 17.8 M0 16.6 Q4.6 19.4 8.4 14.8')}
        <g class="cm-yawn">
          <path d="M-6.6 17.6 C-6.6 26 -3.6 29.4 0 29.4 C3.6 29.4 6.6 26 6.6 17.6 C6.6 15.6 -6.6 15.6 -6.6 17.6 Z" fill="#6d2434" stroke="#3a2f35" stroke-width="1"/>
          <ellipse cx="0" cy="25.6" rx="4.2" ry="2.8" fill="url(#${id}-nose)"/>
          <path d="M-4.8 16.6 l1.1 3 l1.1 -3 Z M4.8 16.6 l-1.1 3 l-1.1 -3 Z" fill="#ffffff"/>
        </g>
        <path class="cm-tongue" d="M-2.8 18 C-2.8 22.6 2.8 22.6 2.8 18 Z" fill="url(#${id}-nose)" stroke="#bf6478" stroke-width="0.6"/>
        <g class="cm-blep"><path d="M-3.6 17.2 C-3.8 25.4 3.8 25.4 3.6 17.2 Z" fill="url(#${id}-nose)" stroke="#bf6478" stroke-width="0.8"/>
          <path d="M0 18.4 V21.6" stroke="#d26a83" stroke-width="0.8" stroke-linecap="round"/></g>
        <path class="cm-sparkle" d="M-38 -24 l1.8 4.4 l4.4 1.8 l-4.4 1.8 l-1.8 4.4 l-1.8 -4.4 l-4.4 -1.8 l4.4 -1.8 Z" fill="#ffd166" stroke="#e0a930" stroke-width="0.8" stroke-linejoin="round"/>
      </g></g></g>
      <g font-family="inherit" font-weight="800" fill="#8e98cf">
        <text class="cm-z cm-z1" x="40" y="-34" font-size="11">z</text>
        <text class="cm-z cm-z2" x="40" y="-34" font-size="13">z</text>
        <text class="cm-z cm-z3" x="40" y="-34" font-size="16">Z</text>
        <text class="cm-q" x="42" y="-38" font-size="22">?</text>
      </g>
      <path class="cm-heart" d="M0 -62 C0 -66 -6 -67.5 -7.2 -63.5 C-8.2 -60 -4 -57 0 -54 C4 -57 8.2 -60 7.2 -63.5 C6 -67.5 0 -66 0 -62 Z" fill="#f07b97"/>
    </g>`;
    }

    // The back of the head, for the cat turned away: black, with the white of the cheeks
    // showing at the sides.
    function backHead(x, y) {
        const id = id_;
        return `<g transform="translate(${x} ${y})"><g class="cm-head-idle"><g class="cm-backhead">
        <g class="cm-ear cm-ear-l"><path d="${EAR_L}" fill="url(#${id}-black)" filter="url(#${id}-ink)"/>${fur('M-31 -19 C-34 -31 -33 -41 -30.5 -47', 1.2, '#5a5d6b')}</g>
        <g class="cm-ear cm-ear-r"><path d="${mirror(EAR_L)}" fill="url(#${id}-black)" filter="url(#${id}-ink)"/>${fur('M31 -19 C34 -31 33 -41 30.5 -47', 1.2, '#5a5d6b')}</g>
        <g filter="url(#${id}-ink)">
          <path d="${HEAD}" fill="url(#${id}-black)"/>
          <g clip-path="url(#${id}-headclip)">
            <path d="M-52 -4 C-44 -2 -37 4 -36 12 C-35 19 -38 24 -44 26 L-52 26 Z" fill="url(#${id}-white)"/>
            <path d="M52 -4 C44 -2 37 4 36 12 C35 19 38 24 44 26 L52 26 Z" fill="url(#${id}-white)"/>
          </g>
        </g>
        ${fur('M-15 -27 q2.5 8 0 16 M0 -31 q2.5 9 0 18 M15 -27 q-2.5 8 0 16 M-8 6 q2 7 0 14 M8 6 q-2 7 0 14', 1.2, '#5a5d6b')}
      </g></g></g>`;
    }

    // ── Poses (each a group, one shown at a time). Where each pose's eyes are, for following. ──
    const EYES_AT = { sit: [128, 63], loaf: [94, 91], lounge: [100, 88], box: [128, 98], belly: [80, 140], turned: [128, 63] };
    const SIT_BODY = 'M128 83 C102 83 88 103 86.5 129 C85 151 89 170 99 177.5 L157 177.5 C167 170 171 151 169.5 129 C168 103 154 83 128 83 Z';
    const SIT_HAUNCH_L = 'M76 160 C76 145.5 85.5 139.5 96 139.5 C108 139.5 114.5 150 114.5 162 C114.5 172.5 106 178.5 95 178.5 C83.5 178.5 76 172.5 76 160 Z';
    const SIT_HAUNCH_R = 'M180 160 C180 145.5 170.5 139.5 160 139.5 C148 139.5 141.5 150 141.5 162 C141.5 172.5 150 178.5 161 178.5 C172.5 178.5 180 172.5 180 160 Z';

    // Sitting up, facing out, the tail curled at its side. With knead, its front paws take
    // turns pressing (making biscuits), its eyes are shut in a smile and it purrs.
    function sitPose(knead = false) {
        const id = id_, key = knead ? 'k' : 's';
        const tailPts = knead
            ? [[158, 171], [184, 172], [200, 154], [203, 128], [199, 106], [190, 94], [181, 92]]
            : [[158, 171], [184, 178], [203, 166], [206, 144], [200, 124], [194, 111], [197, 99]];
        const leg = (side, cx) => `<g class="cm-leg cm-leg-${side}${side === 'l' && !knead ? ' cm-tuck' : ''}">
          ${fur(side === 'l' ? 'M108.5 141 C107 152 107.5 160 109.5 166' : 'M147.5 141 C149 152 148.5 160 146.5 166', 1.5, '#c6c9d6')}
          ${paw(cx, 172.5)}${knead ? beans(cx, 171, 0.55) : ''}
        </g>`;
        // The mug it pats off the edge (sitting only), and the paw that reaches out for it.
        const knock = knead ? '' : `<g class="cm-swipe">${limb([[102, 132], [87, 146], [72, 158]], 14, 12)}${paw(64, 164.5, 0.95)}</g>`;
        const mug = knead ? '' : `<g class="cm-cup">
        <ellipse cx="46" cy="179" rx="10" ry="2.2" fill="#000" opacity="0.12"/>
        <g class="cm-steam">${fur('M43.5 155 q-2 -3 0 -6 q2 -3 0 -6 M49 154 q-2 -3 0 -6', 1.3, '#b9bcc8')}</g>
        <path d="M39.5 165.5 C33 165.5 33 175 40 174.5" stroke="${INK}" stroke-width="4.2" fill="none" stroke-linecap="round"/>
        <path d="M39.5 165.5 C33 165.5 33 175 40 174.5" stroke="#ffa48f" stroke-width="1.6" fill="none" stroke-linecap="round"/>
        <path d="M38.5 159.5 H53.5 L52.5 175 Q52.3 178 49.4 178 H42.6 Q39.7 178 39.5 175 Z" fill="url(#${id}-mug)" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>
        <ellipse cx="46" cy="160" rx="7" ry="1.7" fill="#7a4a2a" stroke="${INK}" stroke-width="1.1"/>
        <path d="M46 168.6 c0 -1.6 -2.4 -2.2 -2.9 -0.6 c-0.4 1.4 1.3 2.6 2.9 3.8 c1.6 -1.2 3.3 -2.4 2.9 -3.8 c-0.5 -1.6 -2.9 -1 -2.9 0.6 Z" fill="#ffffff" opacity="0.9"/>
      </g>`;
        return `<g class="cm-pose cm-pose-${knead ? 'knead' : 'sit'}">${shadow(130, 180, 58)}${mug}<g class="cm-bounce"><g class="cm-sway">
      ${tail(tailPts, knead ? [[-6, 4], [7, -2]] : [[-12, 4], [8, -4], [-4, -6]], knead ? 2.4 : 4.6)}
      ${knock}
      <g class="cm-breathe">
        <g filter="url(#${id}-ink)">
          <path d="${SIT_HAUNCH_L}" fill="url(#${id}-white)"/>
          <clipPath id="${id}-${key}-haunch"><path d="${SIT_HAUNCH_R}"/></clipPath>
          <path d="${SIT_HAUNCH_R}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-${key}-haunch)"><path d="M136 128 V151 C150 158 168 161 184 168 V128 Z" fill="url(#${id}-black)"/></g>
          <clipPath id="${id}-${key}-body"><path d="${SIT_BODY}"/></clipPath>
          <path d="${SIT_BODY}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-${key}-body)">
            <path d="M139 86 C155 94 160 116 158 138 C157 154 152 168 148 179 L192 179 V78 Z" fill="url(#${id}-black)"/>
            <path d="M115 86 C104 95 99 106 98 118 C93.5 116 88.5 115.5 83 116.5 V82 Z" fill="url(#${id}-black)"/>
            <ellipse cx="128" cy="98" rx="27" ry="8" fill="#d9dbe8" filter="url(#${id}-blur)"/>
            <ellipse cx="128" cy="176" rx="34" ry="7" fill="#d9dbe8" opacity="0.8" filter="url(#${id}-blur)"/>
          </g>
        </g>
        ${fur('M152 98 q4 6 3 14 M156 118 q3 6 2 12', 1.3, '#5a5d6b')}
        ${fur('M107 103 q3.5 6.5 7.5 1 M118.5 106.5 q3.5 6.5 7.5 0 M131 106.5 q3.5 6.5 7.5 0 M142.5 103 q2.5 5.5 6 1.5 M112.5 115 q3 5 6.5 0.5 M126 117 q3 5 6.5 0 M137 115 q3 5 6 0.5 M120 127 q3 4.5 6 0 M131 128 q2.5 4 5.5 0')}
        ${contour('M101 148 C99 158 99 167 101.5 175.5 M155 148 C157 158 157 167 154.5 175.5')}
        ${leg('l', 117.5)}${leg('r', 138.5)}
        ${knead ? `<g class="cm-purr">${fur('M78 116 q-5 7 0 14 M71 112 q-8 11 0 22 M178 116 q5 7 0 14 M185 112 q8 11 0 22', 1.6, '#8e98cf')}</g>` : ''}
      </g>
      ${head(128, 63, { mode: knead ? 'happy' : 'open' })}
      ${knead ? '' : `<g class="cm-raised">
        <path d="M111 100 C109 112 107 124 107.5 140 L123.5 140 C124 124 126 111 127.5 100 Z" fill="url(#${id}-forearm)"/>
        <path d="M111 100 C109 112 107 124 107.5 136 M127.5 100 C126 111 124 124 123.5 136" stroke="url(#${id}-forearm-line)" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <ellipse cx="119" cy="97" rx="9.4" ry="7.8" fill="url(#${id}-paw)" stroke="${INK}" stroke-width="1.4"/>
        ${beans(119, 97, 0.9)}
      </g>`}
    </g></g></g>`;
    }

    // A loaf: lying with its paws tucked under, the tail wrapped round the front.
    function loafPose() {
        const id = id_;
        const BODY = 'M84 115 C88 97 118 89 156 91 C195 93 217 113 217 141 C217 166 199 178 160 178 L96 178 C80 178 72 166 74 150 C75 135 78 123 84 115 Z';
        return `<g class="cm-pose cm-pose-loaf">${shadow(144, 181, 78)}<g class="cm-bounce"><g class="cm-sway">
      <g class="cm-breathe">
        <g filter="url(#${id}-ink)">
          <clipPath id="${id}-loaf-body"><path d="${BODY}"/></clipPath>
          <path d="${BODY}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-loaf-body)">
            <path d="M110 78 C132 106 170 117 232 105 V78 Z" fill="url(#${id}-black)"/>
            <path d="M189 127 C200 122 211 124 224 131 V186 H204 C198 166 192 148 189 127 Z" fill="url(#${id}-black)"/>
            <ellipse cx="96" cy="127" rx="28" ry="9" fill="#d9dbe8" filter="url(#${id}-blur)"/>
            <ellipse cx="150" cy="176" rx="60" ry="8" fill="#d9dbe8" opacity="0.8" filter="url(#${id}-blur)"/>
            <ellipse cx="166" cy="104" rx="30" ry="7" fill="#5a5d6b" opacity="0.5" filter="url(#${id}-blur)"/>
          </g>
        </g>
        ${fur('M148 137 q4 5.5 8 0 M164 143 q4 5.5 8 0 M138 154 q4 5.5 8 0 M118 148 q3 5 6.5 0 M180 152 q3.5 5 7 0')}
        ${fur('M140 100 q6 3 12 2 M172 108 q6 2 12 0', 1.3, '#5a5d6b')}
        <g class="cm-tuck">${paw(86, 173.5, 0.95)}${paw(106, 174.5, 0.95)}</g>
      </g>
      ${tail([[208, 157], [221, 172], [207, 182], [180, 182], [154, 180], [133, 177]], [[0, -5], [4, -2]], 5.2, 13.5, 10)}
      ${head(94, 91)}
    </g></g></g>`;
    }

    // Lying down like a sphinx, seen from the front: the chest down to the ground with the front
    // paws side by side under it, a hind leg tucked at its side with the foot forward, and the
    // tail curled round to the front.
    function loungePose() {
        const id = id_;
        const BODY = 'M88 134 C89 110 114 99 146 99 C180 99 202 114 204 139 C206 162 192 177 162 177 L106 177 C92 177 87 160 88 134 Z';
        const HAUNCH = 'M152 141 C152 122 167 113 182 115 C198 117 207 132 205 149 C203 165 191 174 176 174 C161 174 152 161 152 141 Z';
        const RUFF = 'M76 120 Q81 133 87 128 Q91 141 98 133 Q103 145 110 135 Q116 145 121 133 Q127 140 131 127 L131 116 L76 116 Z';
        // The chest down to the ground under the chin; the front legs lie forward, under it.
        const CHEST = 'M72 124 C64 144 67 168 82 176 L122 176 C133 162 136 140 131 120 Z';
        return `<g class="cm-pose cm-pose-lounge">${shadow(140, 181, 78)}<g class="cm-bounce"><g class="cm-sway">
      <g class="cm-breathe">
        <g filter="url(#${id}-ink)">
          <clipPath id="${id}-lounge-body"><path d="${BODY}"/></clipPath>
          <path d="${BODY}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-lounge-body)">
            <path d="M118 84 C140 110 172 118 222 110 V84 Z" fill="url(#${id}-black)"/>
            <ellipse cx="150" cy="176" rx="56" ry="8" fill="#d9dbe8" opacity="0.8" filter="url(#${id}-blur)"/>
            <ellipse cx="168" cy="106" rx="28" ry="6" fill="#5a5d6b" opacity="0.5" filter="url(#${id}-blur)"/>
          </g>
        </g>
        <g filter="url(#${id}-ink)">
          <clipPath id="${id}-lounge-haunch"><path d="${HAUNCH}"/></clipPath>
          <path d="${HAUNCH}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-lounge-haunch)">
            <path d="M144 106 H214 V138 C198 128 176 126 156 136 Z" fill="url(#${id}-black)"/>
            <ellipse cx="178" cy="170" rx="22" ry="6" fill="#d9dbe8" filter="url(#${id}-blur)"/>
          </g>
        </g>
        ${fur('M166 146 q3 5 6 0 M184 152 q3 5 6 0 M176 134 q3 4 6 0')}
        ${tail([[196, 160], [212, 170], [209, 181], [192, 185], [171, 184], [155, 181]], [[0, -3], [3, -1]], 5.6, 13.5, 10)}
        ${paw(150, 175.5, 0.9)}
        <g class="cm-tuck">
          <path d="${CHEST}" fill="url(#${id}-white)" filter="url(#${id}-ink)"/>
          ${fur('M80 150 q3 5 6 0 M98 156 q3 5 6 0 M114 150 q3 5 6 0 M88 138 q3 4 6 0 M108 140 q3 4 6 0')}
          <path d="${RUFF}" fill="url(#${id}-white)" filter="url(#${id}-ink)"/>
          ${fur('M84 124 q2 5 5 3 M98 128 q2 5 5 2 M110 128 q2 5 5 1 M121 124 q2 4 4 1')}
          ${paw(90, 171.5)}${paw(112, 172.5)}
        </g>
      </g>
      ${head(100, 89, { rotate: -3 })}
    </g></g></g>`;
    }

    // Asleep, curled up: head resting on its paws, the tail wrapped round, breathing deeply.
    function sleepPose() {
        const id = id_;
        const BODY = 'M58 160 C56 128 92 109 140 109 C187 109 216 127 216 154 C216 174 193 182 140 182 C92 182 60 178 58 160 Z';
        const HAUNCH = 'M158 130 C158 116 176 111 191 115 C207 119 214 135 210 151 C206 164 192 168 180 166 C166 162 158 148 158 130 Z';
        return `<g class="cm-pose cm-pose-sleep">${shadow(138, 182, 82)}<g class="cm-bounce"><g class="cm-sway">
      <g class="cm-breathe">
        <g filter="url(#${id}-ink)">
          <clipPath id="${id}-sleep-body"><path d="${BODY}"/></clipPath>
          <path d="${BODY}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-sleep-body)">
            <path d="M96 100 C126 124 178 128 232 118 V96 Z" fill="url(#${id}-black)"/>
            <ellipse cx="140" cy="180" rx="70" ry="8" fill="#d9dbe8" opacity="0.8" filter="url(#${id}-blur)"/>
          </g>
          <clipPath id="${id}-sleep-haunch"><path d="${HAUNCH}"/></clipPath>
          <path d="${HAUNCH}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-sleep-haunch)"><path d="M150 104 H222 V132 C206 124 184 124 160 132 Z" fill="url(#${id}-black)"/></g>
        </g>
        ${fur('M120 150 q4 5.5 8 0 M140 156 q4 5.5 8 0 M150 140 q3 5 7 0 M184 146 q3 5 6 0')}
        ${fur('M140 116 q8 4 16 3 M176 120 q6 2 12 0', 1.3, '#5a5d6b')}
      </g>
      ${tail([[207, 155], [218, 171], [204, 183], [176, 186], [146, 185], [119, 180], [101, 173]], [[0, -2], [3, -1]], 6.4, 13.5, 10)}
      <g class="cm-tuck">${paw(86, 170.5, 0.92)}${paw(106, 173, 0.92)}</g>
      ${head(94, 134, { rotate: -14, scale: 0.94, mode: 'sleep' })}
    </g></g></g>`;
    }

    // Stretching, the bottom up and the front low (a play bow), on waking.
    function stretchPose() {
        const id = id_;
        const RUMP = 'M84 100 C84 72 104 57 128 57 C152 57 172 72 172 100 C172 117 156 125 128 125 C100 125 84 117 84 100 Z';
        // Ends in an arch behind the chin, its corners inside the legs, so the floor shows
        // between the front legs.
        const CHEST = 'M93 108 C101 128 106 142 110 152 C118 147 138 147 146 152 C150 142 155 128 163 108 Z';
        return `<g class="cm-pose cm-pose-stretch">${shadow(130, 180, 62)}<g class="cm-bounce"><g class="cm-sway">
      ${tail([[140, 64], [150, 45], [149, 28], [140, 17], [130, 18]], [[-8, 2], [6, -2]], 1.6, 13.5, 10.5)}
      <g filter="url(#${id}-ink)">
        <clipPath id="${id}-stretch-rump"><path d="${RUMP}"/></clipPath>
        <path d="${RUMP}" fill="url(#${id}-white)"/>
        <g clip-path="url(#${id}-stretch-rump)"><path d="M70 50 H186 V96 C160 86 140 92 128 100 C114 90 96 86 70 96 Z" fill="url(#${id}-black)"/></g>
        <path d="${CHEST}" fill="url(#${id}-white)"/>
      </g>
      ${limb([[112, 138], [104, 155], [95, 168]], 15, 11.5)}${paw(92, 172.5)}
      ${limb([[144, 138], [152, 155], [161, 168]], 15, 11.5)}${paw(164, 172.5)}
      ${head(128, 121, { mode: 'squeeze' })}
    </g></g></g>`;
    }

    // Squeezed into a cardboard box (if it fits, it sits): the head and front paws over the
    // front edge, the tail sticking up at the back. Now and then it ducks down and peeks out.
    function boxPose() {
        const id = id_;
        const FRONT = 'M70 126 H190 L186 179 H74 Z';
        const INSIDE = 'M81 113 H179 L190 126 H70 Z';
        const FLAP_B = 'M81 113 H179 L171 100 H89 Z';
        const FLAP_L = 'M70 126 L81 113 L60 101 L47 113 Z';
        const FLAP_R = 'M190 126 L179 113 L200 101 L213 113 Z';
        return `<g class="cm-pose cm-pose-box">${shadow(130, 181, 64)}
      <g filter="url(#${id}-ink)"><path d="${FLAP_B}" fill="url(#${id}-flap)"/><path d="${INSIDE}" fill="url(#${id}-box-in)"/></g>
      <clipPath id="${id}-box-inside"><rect x="0" y="-60" width="${W}" height="236"/></clipPath>
      <g clip-path="url(#${id}-box-inside)"><g class="cm-bounce"><g class="cm-peek">
        ${tail([[168, 120], [183, 106], [190, 89], [187, 74], [178, 67]], [[-6, 3], [6, -2]], 3.8, 13.5, 10)}
        <ellipse cx="128" cy="130" rx="27" ry="14" fill="url(#${id}-white)" filter="url(#${id}-ink)"/>
        ${head(128, 98)}
      </g></g></g>
      <g filter="url(#${id}-ink)">
        <path d="${FRONT}" fill="url(#${id}-box)"/>
        <path d="${FLAP_L}" fill="url(#${id}-flap)"/><path d="${FLAP_R}" fill="url(#${id}-flap)"/>
      </g>
      ${fur('M74 132 H186', 1.2, '#f0cf9c')}
      <g fill="#a8733a" opacity="0.5"><ellipse cx="130" cy="158" rx="6.2" ry="5"/><circle cx="122.4" cy="150.6" r="2.5"/>
        <circle cx="127.4" cy="147.4" r="2.5"/><circle cx="132.6" cy="147.4" r="2.5"/><circle cx="137.6" cy="150.6" r="2.5"/></g>
      <g class="cm-bounce"><g class="cm-box-paws">${paw(112, 125, 0.95)}${paw(144, 125, 0.95)}</g></g>
    </g>`;
    }

    // Rolled over on its back, paws in the air (soft side out), looking at you upside down
    // and sideways. Its paws drift and paddle; pressed, they close in on nothing.
    function bellyPose() {
        const id = id_;
        const BODY = 'M94 157 C92 135 120 123 153 123 C188 123 211 137 209 158 C208 174 190 181 153 181 C116 181 95 175 94 157 Z';
        // Short, bent legs coming up from behind the belly, so their tops don't show.
        const up = (n, pts, at, rot) => `<g class="cm-limb cm-limb-${n}">${limb(pts, 15, 12.5)}${pawUp(at[0], at[1], rot)}</g>`;
        return `<g class="cm-pose cm-pose-belly">${shadow(150, 182, 72)}<g class="cm-bounce"><g class="cm-sway">
      ${tail([[205, 166], [221, 174], [233, 168], [238, 155], [234, 143]], [[4, -4], [-4, 3]], 3.6, 13.5, 10)}
      ${up(1, [[127, 134], [121, 121], [125, 113]], [128, 108], -18)}
      ${up(2, [[146, 130], [145, 118], [151, 111]], [154, 106], 10)}
      ${up(3, [[178, 134], [184, 121], [182, 112]], [181, 106], -6)}
      ${up(4, [[195, 140], [205, 129], [208, 120]], [210, 114], 22)}
      <g class="cm-breathe">
        <g filter="url(#${id}-ink)">
          <clipPath id="${id}-belly-body"><path d="${BODY}"/></clipPath>
          <path d="${BODY}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-belly-body)">
            <path d="M112 190 C124 170 158 165 190 166 C200 156 208 150 222 148 V190 Z" fill="url(#${id}-black)"/>
            <ellipse cx="160" cy="132" rx="38" ry="7" fill="#ffffff" filter="url(#${id}-blur)"/>
          </g>
        </g>
        ${fur('M134 139 q4 5 8 0 M152 135 q4 5 8 0 M170 139 q4 5 8 0 M142 151 q4 5 8 0 M162 152 q4 5 8 0')}
      </g>
      ${head(80, 141, { rotate: -24, scale: 0.94 })}
    </g></g></g>`;
    }

    // Sitting with its back to you, ignoring you; it glances back over its shoulder now and
    // then (and when pressed), with a look.
    function turnedPose() {
        const id = id_;
        return `<g class="cm-pose cm-pose-turned">${shadow(130, 180, 58)}<g class="cm-bounce"><g class="cm-sway">
      <g class="cm-breathe">
        <g filter="url(#${id}-ink)">
          <clipPath id="${id}-turned-haunch"><path d="${SIT_HAUNCH_L}"/></clipPath>
          <path d="${SIT_HAUNCH_L}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-turned-haunch)"><path d="M70 128 V168 C84 160 100 156 120 151 V128 Z" fill="url(#${id}-black)"/></g>
          <path d="${SIT_HAUNCH_R}" fill="url(#${id}-white)"/>
          <clipPath id="${id}-turned-body"><path d="${SIT_BODY}"/></clipPath>
          <path d="${SIT_BODY}" fill="url(#${id}-white)"/>
          <g clip-path="url(#${id}-turned-body)">
            <path d="M72 78 H150 C146 96 149 112 155 124 C149 137 136 141 124 144 C110 148 99 160 93 179 H72 Z" fill="url(#${id}-black)"/>
            <ellipse cx="128" cy="176" rx="34" ry="7" fill="#d9dbe8" opacity="0.8" filter="url(#${id}-blur)"/>
          </g>
        </g>
        ${fur('M128 98 C127 108 127 116 128 126', 1.4, '#5a5d6b')}
        ${fur('M138 150 q4 5 8 0 M150 160 q3.5 4.5 7 0 M132 164 q4 5 8 0')}
        ${contour('M101 148 C99 158 99 167 101.5 175.5 M155 148 C157 158 157 167 154.5 175.5')}
      </g>
      ${tail([[128, 172], [152, 180], [180, 179], [199, 168], [205, 151], [199, 139]], [[3, -6], [6, 2]], 3.2, 13.5, 10)}
      ${backHead(128, 64)}
      <g class="cm-face">${head(126, 64, { rotate: -5, judge: true })}</g>
    </g></g></g>`;
    }

    // A butterfly that flutters past now and then (moved by the script).
    const BUTTERFLY = `<g class="cm-butterfly"><g class="cm-bf">
      <g class="cm-wing cm-wing-l"><path d="M0 -1 C-5 -11 -16 -12 -15 -3 C-14 3 -6 3 0 -1 Z" fill="#ffd166" stroke="#d9912b" stroke-width="0.9"/>
        <path d="M0 0.5 C-5 4 -11 9 -8 12 C-5 14 -1 8 0 0.5 Z" fill="#ffad5c" stroke="#d9912b" stroke-width="0.9"/><circle cx="-9" cy="-4" r="1.6" fill="#fff6dc"/></g>
      <g class="cm-wing cm-wing-r"><path d="M0 -1 C5 -11 16 -12 15 -3 C14 3 6 3 0 -1 Z" fill="#ffd166" stroke="#d9912b" stroke-width="0.9"/>
        <path d="M0 0.5 C5 4 11 9 8 12 C5 14 1 8 0 0.5 Z" fill="#ffad5c" stroke="#d9912b" stroke-width="0.9"/><circle cx="9" cy="-4" r="1.6" fill="#fff6dc"/></g>
      <ellipse rx="1.3" ry="5.4" fill="#3b2f2f"/>
      <path d="M-0.6 -5 q-2 -4 -4 -5 M0.6 -5 q2 -4 4 -5" stroke="#3b2f2f" stroke-width="0.8" fill="none" stroke-linecap="round"/>
    </g></g>`;

    function svgHtml(id) {
        id_ = id;
        const ink = (name, radius) => `<filter id="${id}-${name}" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">
      <feMorphology in="SourceAlpha" operator="dilate" radius="${radius}" result="grow"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4" result="noise"/>
      <feDisplacementMap in="grow" in2="noise" scale="1.6" xChannelSelector="R" yChannelSelector="G" result="wobble"/>
      <feFlood flood-color="${INK}"/>
      <feComposite in2="wobble" operator="in" result="line"/>
      <feMerge><feMergeNode in="line"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
        const linear = (name, stops) => `<linearGradient id="${id}-${name}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;
        return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <defs>
    <!-- The ink line: the shapes' outline grown, with a slight hand-drawn wobble; finer for the legs -->
    ${ink('ink', 1.5)}${ink('ink-fine', 1.1)}
    <filter id="${id}-soft" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="${id}-blur" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="3.2"/></filter>
    <filter id="${id}-fuzz" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4"/></filter>
    <clipPath id="${id}-headclip"><path d="${HEAD}"/></clipPath>
    <clipPath id="${id}-eye-l"><ellipse cx="-15.5" cy="${EYE.cy}" rx="${EYE.rx}" ry="${EYE.ry}"/></clipPath>
    <clipPath id="${id}-eye-r"><ellipse cx="15.5" cy="${EYE.cy}" rx="${EYE.rx}" ry="${EYE.ry}"/></clipPath>
    <radialGradient id="${id}-black" cx="0.4" cy="0.3" r="0.85">
      <stop offset="0" stop-color="#4a4c57"/><stop offset="0.55" stop-color="#2d2e35"/><stop offset="1" stop-color="#1d1e23"/>
    </radialGradient>
    <radialGradient id="${id}-white" cx="0.45" cy="0.35" r="0.75">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.65" stop-color="#f7f7fb"/><stop offset="1" stop-color="#e3e5ee"/>
    </radialGradient>
    <radialGradient id="${id}-face" cx="0.5" cy="0.55" r="0.65">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.75" stop-color="#f8f8fb"/><stop offset="1" stop-color="#e6e8f0"/>
    </radialGradient>
    <radialGradient id="${id}-paw" cx="0.5" cy="0.35" r="0.7">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e8e9f1"/>
    </radialGradient>
    <linearGradient id="${id}-ear" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#e98aa0"/><stop offset="1" stop-color="#f7bccb"/>
    </linearGradient>
    <radialGradient id="${id}-iris" cx="0.5" cy="0.6" r="0.62">
      <stop offset="0" stop-color="#f6f9b0"/><stop offset="0.5" stop-color="#d0dd55"/><stop offset="0.85" stop-color="#9db12f"/><stop offset="1" stop-color="#76891f"/>
    </radialGradient>
    ${linear('nose', [[0, '#f6a7b8'], [1, '#e57f97']])}
    ${linear('mug', [[0, '#ffb9a8'], [1, '#f28d76']])}
    ${linear('box', [[0, '#e3b273'], [1, '#c8924f']])}
    ${linear('box-in', [[0, '#5e3d22'], [1, '#8a5c33']])}
    ${linear('flap', [[0, '#f0c88f'], [1, '#d9a765']])}
    <linearGradient id="${id}-forearm" x1="0" y1="100" x2="0" y2="140" gradientUnits="userSpaceOnUse">
      <stop offset="0.6" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${id}-forearm-line" x1="0" y1="100" x2="0" y2="136" gradientUnits="userSpaceOnUse">
      <stop offset="0.5" stop-color="${INK}"/><stop offset="1" stop-color="${INK}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${sitPose()}${sitPose(true)}${loafPose()}${loungePose()}${sleepPose()}${stretchPose()}${boxPose()}${bellyPose()}${turnedPose()}
  ${BUTTERFLY}
</svg>`;
    }

    const weighted = obj => {
        const entries = Object.entries(obj);
        let roll = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
        for (const [name, w] of entries) if ((roll -= w) < 0) return name;
        return entries[0][0];
    };
    const between = ([a, b]) => a + Math.random() * (b - a);

    function mount(el) {
        if (!el || el.dataset.catMounted) return;
        el.dataset.catMounted = '1';
        addStyle();
        const id = `cm${++count}`;
        el.classList.add('cat-mascot');
        el.innerHTML = svgHtml(id);
        const svg = el.querySelector('svg');

        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (still) svg.pauseAnimations?.();
        // Only worth doing while it can be seen: the tab is open and it has a size.
        const onScreen = () => document.visibilityState === 'visible' && el.offsetWidth > 0;
        let state = null, shown = null, current = null, endTimer = 0, stateTimer = 0, stretchTimer = 0;

        function show(pose) {
            const was = shown;
            shown = pose;
            el.dataset.pose = pose;
            el.querySelectorAll('.cm-pose').forEach(g => {
                const on = g.classList.contains(`cm-pose-${pose}`);
                g.classList.toggle('is-on', on);
                g.classList.remove('is-entering');
                if (on && was) { void el.offsetWidth; g.classList.add('is-entering'); }
            });
        }
        const finish = () => {
            clearTimeout(endTimer);
            if (current) el.classList.remove(`cm-act-${current}`);
            if (current === 'butterfly') butterflyEnd();
            current = null;
        };
        const act = name => {
            finish();
            void el.offsetWidth; // restart the animation when the same class comes back
            el.classList.add(`cm-act-${name}`);
            current = name;
            if (name === 'butterfly') butterflyStart();
            // Knocking the mug off: a look at the mug first, then right at you.
            if (name === 'knock') { focus = { pt: [46, 168], until: performance.now() + 1600 }; wake(); }
            endTimer = setTimeout(finish, ACTION_MS[name] || 1000);
        };

        // A new state; waking (or getting up) comes with a stretch first.
        function setState(next, { stretch } = {}) {
            finish();
            clearTimeout(stateTimer);
            clearTimeout(stretchTimer);
            const wake = stretch ?? (state === 'sleep' || (['loaf', 'lounge', 'belly'].includes(state) && next === 'sit' && Math.random() < 0.4));
            state = next;
            if (wake && !still) {
                show('stretch');
                stretchTimer = setTimeout(() => show(next), STRETCH_MS);
            } else show(next);
            if (!still) stateTimer = setTimeout(() => setState(weighted(STATES[state].next)), between(STATES[next].stay) + (wake ? STRETCH_MS : 0));
        }

        // ── Eyes that follow the pointer, the butterfly, or something it has its eye on ──
        let pointer = null, pointerAt = 0, gaze = [0, 0, 0], frame = 0, bf = null, focus = null;
        const toSvg = (x, y) => {
            const m = svg.getScreenCTM?.();
            if (!m) return null;
            const p = new DOMPoint(x, y).matrixTransform(m.inverse());
            return [p.x, p.y];
        };
        function tick(now) {
            frame = 0;
            let target = null;
            const focused = focus && now < focus.until;
            if (bf) {
                const t = Math.min(1, (now - bf.start) / bf.ms);
                const x = bf.x0 + (bf.x1 - bf.x0) * t + 16 * Math.sin(t * Math.PI * 3 + bf.phase);
                const y = bf.y0 + (bf.y1 - bf.y0) * t + 18 * Math.sin(t * Math.PI * 4.4 + bf.phase);
                bf.el.setAttribute('transform', `translate(${r1(x)} ${r1(y)}) rotate(${r1(Math.cos(t * Math.PI * 3 + bf.phase) * 22)})`);
                target = [x, y];
                if (t >= 1) butterflyEnd();
            } else if (focused) target = focus.pt;
            else if (pointer && now - pointerAt < 4000) target = toSvg(...pointer);
            const eyes = EYES_AT[shown];
            let goal = [0, 0, 0];
            if (target && eyes) {
                const dx = target[0] - eyes[0], dy = target[1] - eyes[1], len = Math.hypot(dx, dy) || 1;
                // Within about two cat-widths: the pupils go up to 3 units toward it.
                if (len < 600) {
                    const reach = Math.min(3, len / 22);
                    goal = [dx / len * reach, dy / len * reach * 0.8, Math.max(-1, Math.min(1, dx / 160))];
                }
            }
            gaze = gaze.map((g, i) => g + (goal[i] - g) * 0.16);
            svg.style.setProperty('--gx', r1(gaze[0]));
            svg.style.setProperty('--gy', r1(gaze[1]));
            svg.style.setProperty('--gt', Math.round(gaze[2] * 100) / 100);
            const settled = gaze.every((g, i) => Math.abs(g - goal[i]) < 0.05);
            if (!still && onScreen() && (bf || focused || (pointer && now - pointerAt < 4000) || !settled)) frame = requestAnimationFrame(tick);
        }
        const wake = () => { if (!frame) frame = requestAnimationFrame(tick); };
        document.addEventListener('pointermove', e => {
            if (e.pointerType === 'touch') return;
            pointer = [e.clientX, e.clientY];
            pointerAt = performance.now();
            wake();
        }, { passive: true });

        function butterflyStart() {
            const left = Math.random() < 0.5;
            bf = {
                el: svg.querySelector('.cm-butterfly'), start: performance.now(), ms: ACTION_MS.butterfly - 300,
                x0: left ? -30 : 290, x1: left ? 290 : -30, y0: 20 + Math.random() * 40, y1: -10 + Math.random() * 50,
                phase: Math.random() * Math.PI * 2,
            };
            bf.el.classList.add('is-on');
            wake();
        }
        function butterflyEnd() {
            if (!bf) return;
            bf.el.classList.remove('is-on');
            bf = null;
        }

        // ── Living ──
        setState(weighted(Object.fromEntries(Object.entries(STATES).map(([n, s]) => [n, s.weight]))), { stretch: false });

        let lastAction = null;
        if (!still) (function idleLater() {
            setTimeout(() => {
                if (onScreen() && !current && shown === state) {
                    const choices = { ...STATES[state].actions };
                    delete choices[lastAction];
                    lastAction = weighted(choices);
                    act(lastAction);
                }
                idleLater();
            }, 3500 + Math.random() * 6000);
        })();

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && !still) svg.unpauseAnimations?.();
            else svg.pauseAnimations?.();
        });

        // A press: a bounce. A sleeping cat wakes up (with a stretch) instead, and one with its
        // back to you only looks round (and may give in and turn back). Pressed four times in
        // a few seconds, it shows a little attitude: an unamused look, a "hmph", or its back.
        let presses = [], sassTimer = 0;
        el.addEventListener('click', () => {
            if (still) return;
            if (state === 'sleep') { setState(Math.random() < 0.6 ? 'sit' : 'loaf', { stretch: true }); return; }
            if (shown === 'stretch') return;
            if (state === 'turned') {
                act('glance');
                if (Math.random() < 0.5) {
                    clearTimeout(stateTimer);
                    stateTimer = setTimeout(() => setState('sit', { stretch: false }), ACTION_MS.glance);
                }
                return;
            }
            const now = performance.now();
            presses = presses.filter(t => now - t < 6000).concat(now);
            act('bounce');
            // Once due, it waits for the last bounce to end, however many presses follow.
            if (presses.length >= 4 || sassTimer) {
                presses = [];
                clearTimeout(sassTimer);
                sassTimer = setTimeout(() => {
                    sassTimer = 0;
                    if (current || shown !== state || !SASSY.has(state)) return;
                    if (state === 'sit' && Math.random() < 0.35) setState('turned', { stretch: false });
                    else act(['sit', 'loaf', 'lounge'].includes(state) && Math.random() < 0.5 ? 'hmph' : 'unamused');
                }, ACTION_MS.bounce + 50);
            }
        });
        // For trying it out in the console: el.catMascot.state('box'), el.catMascot.act('knock').
        el.catMascot = { state: (name, opts) => setState(name, opts), act, get current() { return { state, shown, action: current }; } };
    }

    function mountAll() { document.querySelectorAll('[data-cat-mascot]').forEach(mount); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
    else mountAll();

    return { mount };
})();
