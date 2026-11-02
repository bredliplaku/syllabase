/* The cat companion of the course pages (js/course-page.js), here only while an exam is
   taken, with lines about exams to pass the time. A press shows a line in its bubble.
   It never opens anything (no easter-egg link, unlike the course page's): a new tab would
   count as leaving the page (js/integrity.js). config.catCompanion === false removes it. */
const examCat = (() => {
    // Emojis sparingly: only two of the Albanian cheers have one.
    const LINES = [
        // About the exam
        "Read the question twice. I read my food bowl three times. It still said 'empty'.",
        "Stuck? Skip it and come back later. That's how I deal with closed doors.",
        "Press Confirm on each answer. I confirm things by knocking them off the table.",
        "Deep breath in... and out. You've got this.",
        "No wandering off to other tabs: the page notices. I notice too. I always notice.",
        "Show your working. Partial marks are like half a treat: still a treat.",
        "Your first instinct is often right. Mine is always 'nap'.",
        "Check your units. Metres, not meows.",
        "I'm not allowed to help. Officially. Unofficially, I also don't know the answer.",
        "Finished early? Look over your answers. I'll be here, supervising.",
        "The timer ticks, I purr. Same rhythm, very different stress levels.",
        "A long answer? Plan it first, then write. Like stalking a laser dot.",
        "Every confirmed answer is a tiny victory. Celebrate quietly.",
        "Mind gone blank? Write down what you do know. It warms the brain up, like a sunbeam.",
        "Multiple choice tip: rule out the silly ones first. Like 'cats dislike naps'.",
        "I believe in you. I also believe in second breakfast.",
        "Hard question? Stare at it like I stare at a wall. Eventually something shows up.",
        "Neat handwriting isn't needed here. Neat thinking is.",
        "Blink slowly at the question. It's a sign of trust. It may trust you back.",
        "Keep your answers short and clear. Like my demands: food, now.",
        "If a question looks impossible, it's probably just a long one in disguise.",
        "Exams are temporary. Naps are forever.",
        "I once sat an exam. Literally. I sat on it. Top marks for comfort.",
        "Spelling counts less than you think. Unless it's my name. Spell my name right.",
        "Calculators are allowed if your lecturer says so. Paws are always allowed.",
        "Your lecturer can't see me. I'm the only invigilator who naps on the job.",
        "If you can explain it to a cat, you understand it. Go on, I'm listening. Mostly.",
        "Don't panic when others look busy. They might just be drawing cats in the margin.",
        "When this is over, you deserve a snack. I deserve one too, for moral support.",
        "Rereading your answer? Good. I reread the room before every jump. Mostly.",
        "Clicking me doesn't add marks. I checked. Twice.",
        "I'm guarding your answers. Nobody gets past me. Except the cleaner. And the sunbeam.",

        // From the course pages
        "Go on, click me again. I dare you.",
        "I am not a button. I am a supervisor. Please show some respect.",
        "Was that click necessary? I was in the middle of a very important... thought.",
        "Don't worry, I'm supervising. Every click you make is being carefully monitored from this very comfortable spot.",
        "That clicking sound from your keyboard is disrupting my nap. Please type softer.",
        "Exam stress? Sounds hard. You should probably pet me after. It helps.",
        "Psst. I helped build this page... mostly by sitting on the keyboard.",
        "I'm not sleeping, I'm compiling. It's a very complex process.",
        "Your computer is warm. This is good. It is performing its primary function as a heated bed.",
        "If I fits, I sits. This is the first law of feline physics.",
        "I think, therefore I am... sleepy.",
        "Blinking slowly at you. That's a sign of trust, you know.",
        "Need a study buddy? I'm available for moral support, provided it doesn't involve moving.",

        // Shqip
        "Suksese në provim! 🤞",
        "Qetësohu, ke kohë. Lexoje pyetjen me kujdes.",
        "Mund t'ia dalësh! 💪",
    ];

    let lastLine = '';
    let hideTimer = 0;
    let wired = false;

    // A line about this exam now: the whole minutes left (19:59 is 19), or how many answers
    // are confirmed.
    function liveLine() {
        const left = typeof examEndTime === 'number' ? Math.floor((examEndTime - Date.now()) / 60000) : NaN;
        const counts = typeof getConfirmationCounts === 'function' ? getConfirmationCounts() : null;
        const options = [];
        if (left > 1) options.push(left > 30
            ? `${left} minutes left. Plenty of time. Not nap time, sadly.`
            : `${left} minutes left. Keep going, steady paws.`);
        if (counts?.required) options.push(counts.allConfirmed
            ? 'Everything is confirmed! Submit it, then go and have a nap. I insist.'
            : `${counts.confirmed} of ${counts.required} confirmed. I have confirmed none, but I am a cat.`);
        return options[Math.floor(Math.random() * options.length)] || '';
    }

    function nextLine() {
        let line;
        do {
            line = Math.random() < 0.25 && liveLine() || LINES[Math.floor(Math.random() * LINES.length)];
        } while (line === lastLine);
        return (lastLine = line);
    }

    function speak() {
        const bubble = document.getElementById('cat-speech-bubble');
        if (!bubble) return;
        bubble.textContent = nextLine();
        bubble.classList.add('visible');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => bubble.classList.remove('visible'), 6000);
    }

    function wire(cat) {
        if (wired) return;
        wired = true;
        cat.setAttribute('role', 'button');
        cat.setAttribute('tabindex', '0');
        cat.setAttribute('aria-label', 'Cat companion: press for a message');
        cat.addEventListener('click', event => { event.stopPropagation(); speak(); });
        cat.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            speak();
        });
        // A press elsewhere closes the bubble.
        document.addEventListener('click', event => {
            if (!cat.contains(event.target)) document.getElementById('cat-speech-bubble')?.classList.remove('visible');
        });
    }

    // Shown while an exam is taken (showView), gone otherwise.
    function toggle(on) {
        const cat = document.getElementById('cat-companion');
        if (!cat) return;
        if (window.TEACHING_CONFIG?.catCompanion === false) { cat.remove(); return; }
        wire(cat);
        cat.classList.toggle('visible', on);
        if (!on) document.getElementById('cat-speech-bubble')?.classList.remove('visible');
    }

    return { toggle };
})();
