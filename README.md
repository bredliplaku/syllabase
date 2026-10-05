# syllabase
A central platform where lecturers publish and share course materials, syllabi and teaching resources.

This guide records how accounts, lecturer websites and updates work.
Course content and permissions are stored in one Supabase project. The central
website serves the application; lecturers display their assigned courses on
their own websites through an uploaded `index.html` file.

[Accounts](#accounts-and-permissions) · [Lecturer websites](#lecturer-websites) · [Exams](#exams) · [Maintenance](#maintenance) · [Files](#file-reference) · [Troubleshooting](#troubleshooting)

## Accounts and permissions

### Add someone

Open the site root (`/`), sign in with Google, then select your photo and name in the top bar to open **Settings**.

1. Choose **Add account** and enter the person's Google sign-in email.
2. Select their role: **Admin**, **Lecturer** or **Student**.
3. Select their courses. For a Lecturer or Student, these are the courses they
   can work on. An Admin can edit every course; their selection is a personal
   list (see [My courses](#my-courses-and-the-main-course-page)).
4. Save. They can now sign in using that Google account.

**Names come from Google.** You can add someone before their first sign-in;
their email is shown until their Google name is available. Adding an account does
not send an invitation email. See [Profiles](#profiles) for display names and photos.

### What each role can do

| Role | Courses | Editable content | Course actions |
|---|---|---|---|
| **Admin** | All, including future courses | Everything | Create, archive, restore, delete |
| **Lecturer** | Assigned courses | Everything except Course Identity and Dates | Archive |
| **Student** | Assigned courses | Modules, Projects, Announcements and grading [exams](#exams) | None |

Students can read the other tabs. Restricted controls are disabled, and Supabase
checks permissions on every write, including requests made outside the editor.

**Settings access:**

- **Admins** manage all accounts, roles and assignments. At least one Admin must remain.
- **Lecturers** see their own profile and all active Students. They can select an
  existing Student or use **Add student**, then assign only their own courses.
- **Students** see only their own account, to edit their [profile](#profiles).

> **Removing a student's access as a Lecturer** removes only the assignments
> for that lecturer's courses. The student stays listed and keeps access granted
> by other lecturers. Only an Admin can remove the whole account.

### Assign or remove courses

Select the person in Settings, check or uncheck their courses, then save.
Use the search and **Active**, **Archived**, **All** or **Assigned** filters to
find the right course and semester. The search matches the course code, name,
semester, year and the [lecturers](#lecturers-on-course-pages) assigned to it.
The sidebar has the same search.

Active and archived offerings have separate assignments. Archiving or restoring
a course moves its assignments with it. After an access change, reload an open
editor to refresh the controls; the database already uses the new permissions.

### My courses and the main course page

Admins can select courses too. Selecting them does not restrict what an Admin
can edit:

- **Sidebar:** an Admin with selected courses sees them under **My courses**.
  **All courses** lists every course again. The choice is remembered in that browser.
- **New courses:** the [New Course](#new-courses) dialog ticks you as a lecturer
  when you keep a course list, so the course joins it. Untick to leave it out.
- **Main course page:** `/courses/` lists the courses selected for the
  account configured as the main page owner in Supabase,
  in the same way a lecturer's website lists their assigned courses. Settings
  marks that account. While it has no courses selected, the page lists every course.

The main page only opens courses in that list. Links to other courses on
`/courses/#…` stop working; share those from the lecturer's own website instead.

### Profiles

Select your photo and name in the top bar, then your account in Settings.

- **Display name:** shown on course pages instead of the Google name. Leave it
  empty to use the Google name.
- **Photo:** the Google photo. If the Google account has none, a **Photo
  address** (`https://…`) can be set instead.

Everyone can edit their own profile, and Admins can edit anyone's. A Lecturer
cannot edit a Student's name or photo. An account with no name to show is left
off course pages; its email is never shown there.

### Lecturers on course pages

A course's lecturers are the **Lecturer** and **Admin** accounts assigned to it
in Settings. The course header shows their display names and photos, on the
main page, lecturer websites and in the editor. Names are not links. The Info
tab lists them read-only; change them in Settings.

Lecturers are listed by title everywhere: Prof. (Dr.), Assoc. Prof. (Dr.), Dr. or
PhD, then Mr/Ms/Mrs/MSc/MA/PM, then BA/BSc, and names without a title last; A–Z by
name within each. Titles count at the start of the name or after a comma.

Lecturer entries saved in older versions of the Info tab are kept, and are shown
only for a course nobody is assigned to yet.

### Previewing a course

**Preview**, beside Archive and Delete on the course header, opens the course's
public page in a new tab, for every role. Which page depends on where you signed in:

1. On a lecturer's website: that website, when the course is one of that lecturer's.
2. Otherwise your own lecturer page, if the course is assigned to you.
3. Otherwise the page of another lecturer assigned to it.
4. Otherwise the main course page (`/courses/`), if it lists the course.

When none of these shows the course, Preview stays dimmed.

### New courses

**New Course** in the sidebar asks for the Course Identity and the lecturers.
Code, title, academic year and semester are required. The course's link is made
from its code, e.g. `CE 101` → `CE_101` and `SWE / CE 101` → `SWE_CE_101`; an
active course already using that link must be archived first. New courses start
as Active.

**Order everywhere:** newest academic year first, then Summer → Spring → Fall,
then course number (`CE 123`, `ARCH 203`, `CE 345`). Cross-listed codes such as
`SWE / CE 101` follow, A–Z.

## Lecturer websites

There are two parts: upload the public page, then approve its sign-in address.
The lecturer needs access to upload a file to their website; they do not need
GitHub or a separate Supabase project.

### 1. Download and upload

1. In Settings, save the Lecturer or Admin account and its course assignments.
2. Select that account and choose **Download index.html**. Lecturers can
   download their own file too; Admins can download anyone's, including their own.
3. Upload it as `index.html` to the desired website folder.
4. Open that folder's address. It should show the lecturer's assigned courses.

> **Downloaded files always load from `https://syllabase.al/`**, wherever the
> download was made. The address is `DOWNLOAD_APP_URL` at the top of
> [js/sites.js](js/sites.js); change it only if the app moves.

**Example:** uploading to the `academic` folder on `example.com` gives:

| Page | Address |
|---|---|
| Public courses | `https://example.com/academic/` |
| Admin / Sign In | `https://example.com/academic/?admin` |

The host must serve the file as a web page. The public page works without
registering its address. The upload creates no `/academic/admin/` folder;
the Sign In button opens `?admin` on the same website.

### 2. Allow sign-in

Each new website is registered in two places. Use the HTTPS address the browser
actually ends up on, and add the `www` version separately if visitors use it.

| Where | What to add | Needed for |
|---|---|---|
| **Supabase** → Authentication → URL Configuration → Redirect URLs | The full admin address, including the folder and `?admin` | Sign-in (required) |
| **Google Cloud Console** → APIs & Services → Credentials → the existing OAuth client → Authorised JavaScript origins | The origin only, with no folder or path | The Drive picker (optional) |

For the example above, the entries are:

```text
Supabase:      https://example.com/academic/?admin
               https://www.example.com/academic/?admin
Google Cloud:  https://example.com
               https://www.example.com
```

Add exact addresses, without broad wildcards, and keep the project's existing
**Site URL**. An unapproved return address may send the person to the Site URL instead.

**Without the Google Cloud origin**, the Sign In button and pasted Drive links
still work, but the Drive picker cannot open. Lecturer websites never show
Google's One Tap prompt.

**Google sign-in stays in Supabase.** It uses the existing Google provider and
its OAuth client; there is no new Google client to create for each lecturer.
Do not delete that client or change its Supabase callback under **Authorised
redirect URIs**: Supabase sign-in depends on both. Anyone signing in gets their
own account's permissions, regardless of whose website they visit.

**Website approval controls sign-in returns.** It cannot prevent copying the
public file, and removing an approved address does not revoke existing sessions.
Approve trusted websites; remove account or course access in Settings when needed.

### Several lecturers on one domain

Lecturers can share one domain, each in their own folder, such as
`https://example.com/lecturer-a/` and `https://example.com/lecturer-b/`.
If you control the whole domain, register it once:

```text
Supabase:      https://example.com/**
Google Cloud:  https://example.com
```

After that, a new lecturer on that domain only needs their file uploaded to a
new folder; no Supabase or Google Cloud change is needed.

- The footer **Home** link goes to the domain root. On the Syllabase domain
  itself that is the homepage course list. On `?admin`, the footer's **Back**
  arrow returns to the lecturer's course page; it is left out when that page is
  the domain root too (a file at `https://example.com/`), where Home already goes.
- The pages share one browser origin. Signing in on one lecturer's `?admin`
  also signs the person in on the others in that browser, with their own
  permissions. On shared computers, sign out after use.

### Lecturer folders on syllabase.al

Name the folder after the lecturer's email handle, such as `bplaku/` for
`bplaku@epoka.edu.al`, and upload their downloaded `index.html` into it. The
homepage then lists their courses under **Browse courses**, with no other step.
For their **Sign In** (`/bplaku/?admin`), register `https://syllabase.al/**`
once, as in [Several lecturers on one domain](#several-lecturers-on-one-domain).

- Courses are listed as a table grouped by term, each term with its number of
  courses. Visitors can search (by code, name, lecturer, semester or year),
  switch between **Current**, **Past** and **All**, and pick a term or lecturer.
  <kbd>/</kbd> jumps to the search, and <kbd>Enter</kbd> opens the course when
  the search leaves exactly one.
- Each course opens on its lecturer's page, such as `/bplaku/#CE_121`. A row
  shows its lecturers' photos and names; a course with several lecturers links
  each of them, showing up to three names and then "+N more".
- **The homepage** (`https://syllabase.al/`) links to the class timetable under
  its title, shows the list open, and has a small **Sign in** button below it.
  Each browser remembers whether the list was left open and its last tab, term
  and lecturer; search text is not kept.
- **`?admin`**, on the homepage or a lecturer's website, shows a large **Sign
  in** button above the closed list; it remembers its own open state. A
  lecturer's `?admin` starts on that lecturer's courses. Filters chosen on
  `?admin` are not saved, so the homepage keeps its own.
- Google's One Tap prompt appears only on `https://syllabase.al/?admin`, never
  on the homepage or on lecturer websites.
- A lecturer is listed only once their folder holds their own file. Folders
  named differently are not found. Courses with no lecturer page are left out.
- Its data comes from the public `teaching_directory` database function: each
  lecturer's name, photo, email handle (the part before `@`) and course card
  details, including the course colour.
- Do not name a folder after one of the app's own: `courses`, `timetable`,
  `exam`, `css`, `js`, `favicon`, `supabase` or `miscellaneous`.
- Mistyped addresses reach [404.html](404.html). It sends a lecturer's address
  typed with capitals or with a course after it (`/BPlaku`, `/bplaku/CE_121`) to
  the folder, opening that course; anything else gets links to the course list
  and the timetable.

### After upload

The file loads the current application and course data. It contains a public
lecturer ID, not a password. Link previews show its title ("Syllabase"), a fixed
one-line description and, in apps that show one, the website's own favicon;
nothing in the file needs updating when a name or icon changes.

The initial theme styles and favicon link live in the downloaded HTML itself.
To update those in an existing upload, download and replace its `index.html` once.
The favicon comment shows where to set the website's own icon; the loader keeps it.

Icons come from the Font Awesome kit, which loads only on the domains listed in
the kit's settings. On any other website the loader uses the same free icons from
jsDelivr instead, following the latest 7.x release as the kit does. If the kit
moves to a new major version, change `@7` in [embed.js](embed.js) to match.

| Change | What happens |
|---|---|
| Edit course content or update the application | The website picks up the changes; no new upload is needed. |
| Assign or remove a course | The lecturer's course list changes. |
| Change a Google name | The name updates when the account data refreshes. |
| Download the file again | Earlier copies remain valid. |
| Change the role to Student or remove the account | That public course page becomes unavailable. |
| Restore the Lecturer or Admin role | The same file works again, using the same website ID. |

Course pages are public. Removing an assignment removes it from that lecturer's
website; it does not make the course private wherever it is otherwise listed.

## Exams

Lecturers prepare exams in the editor, on each course's **Exams** and
**Students** tabs. Students take exams and see their results at
[`/exam/`](https://syllabase.al/exam/). An active course's page lists its exams
(date, duration and hall) until they end, with a **Go to exam** link while an exam with questions is open (one without just says Now).

### Students

1. Copy the class list from EIS (or the whole page, Ctrl+A) and paste it. Each
   student needs a name and an email; the student ID and programme are read when
   there. The preview shows new and updated students and any rows it could not
   read. A status after a name (`R EX`, `Termination: 13 Jun 2026`) is kept as a
   note. Attendance is not kept.
2. For midterm and final exams, paste the exam's grade list from EIS (or the whole
   page). Only the exam IDs are kept, in EIS's order; they are never linked to
   students. Saving replaces the list, so paste each semester's new IDs. Exam IDs
   belong to one course and semester: EIS reshuffles them, so the same ID in
   another course or semester is someone else's.
3. Choose **Save** (or Ctrl/Cmd+S).

Pasting again finds students already on the list by email (else by student ID),
so their exams and grades stay with them. The preview shows what would change
(**Replace**), and Save asks before replacing their details. Everyone else is kept
unless you tick **Remove the students not in this paste**.

**One student ID and email per person.** A student keeps the same student ID and
email in every course, archived ones included. The preview checks a paste against
the other courses:

| Pasted row | Result |
|---|---|
| Student ID that has another email in another course | Marked in red; Save is refused until you correct it (here or in the other course). |
| Email that has another student ID in another course | Marked in red; Save is refused until you correct it (here or in the other course). |
| Email without a student ID | Takes the student ID that another course has for that email. |
| Same student ID and email, different name | Saved, with a note: each course keeps its own spelling. |
| Same name, different student ID and email | Two different people. |

The same check applies when you edit a student. If a student's email really
changes, edit it in the other courses too.

Click a row to select it; Ctrl/Cmd+click and Shift+click select several, and
Ctrl/Cmd+A all of them once one is selected (on a phone, use the checkboxes).
**Edit** changes one student, or the programme of several at once; **Delete**
(or the Delete key) removes them. Each row and each exam ID also has its own
edit button. A student's **Exam ID** column is only a note for finding someone:
it does not sign them in or link their results. These changes save at once.

### Create and grade an exam

**New exam** starts with the **Assessment**: an entry from the **Grading** tab
(Quiz 1, Midterm 1, Final…), which fills in the label, type and weight, or
**Custom** to fill them in yourself. Then come the date and time, duration, hall,
base (100 by default), sign-in and exam password. Sign-in is **Student ID** by
default; midterm, final, resit and additional exams default to **Exam ID
(anonymous)**. Both sign in with the exam password, so they need one once the
exam has questions (a card without one says so, with a link to set it); with
**Google account** it is optional. **Add exam** then opens the exam's questions.
An exam without questions (held on paper) is only listed.

| Switch | Off | On |
|---|---|---|
| **Visible to students** | A draft only lecturers see. | Students see it on their dashboard and the course page, and can start it when it opens. |
| **Grades visible to students** | Grades stay hidden while you grade. | Students see their grade, answers, comments and feedback. |

With an assessment chosen, turning on **Grades visible to students** marks that
entry **Done** on the Grading tab and locks it there (its Done and remove
controls): set the exam's Assessment to **Custom** to change it. When the Grading
tab renumbers entries (removing Quiz 1 makes Quiz 2 the new Quiz 1), exams follow
their entry; an exam whose entry was removed becomes Custom.

### Questions

Each exam's **Questions** button opens its questions. Add a question with the
buttons at the bottom, one per type:

| Type | Students answer with | Autograding |
|---|---|---|
| **Multiple choice** | One of the options | Right when the chosen option is ticked as correct |
| **Short answer** | A line of text | Right when it matches an accepted answer (capitals and spaces ignored); none listed means by hand |
| **Numeric** | A number, with the unit beside it | Right when within the tolerance (± 0 by default) |
| **Long answer** | A text box, optionally with starting text | By hand |
| **Code** | A code editor, optionally with starter code | By hand |
| **File upload** | A file (only its name is recorded) | By hand |
| **Information** | Nothing: instructions or a heading | Not graded |

Drag the handle (or use the arrows) to reorder; duplicate, delete and collapse
cards from their header. In options, Enter adds the next one, and pasting several
lines adds one option per line. An optional **Explanation** is shown to students
with their grade. **Preview** shows the exam as students see it, with the answers
on request. **Save** (or Ctrl/Cmd+S) checks each question and stores them; leaving
with unsaved changes asks first. Once students have submitted, don't reorder or
remove questions: answers are matched by position.

**Import and export.** **Export** downloads the questions as JSON. **Import**
takes such a file, pasted JSON, or another exam of the course, adding to or
replacing the current questions after a preview. For another professor's exam,
choose **Copy instructions for Claude** in Import, give Claude those instructions
with the exam (PDF, Word or text), and paste its reply. The format:

```json
{
  "format": "syllabase-questions",
  "version": 1,
  "questions": [
    { "type": "multiple_choice", "points": 2, "question": "…", "options": ["…", "…"], "correct": ["…"], "explanation": "…" },
    { "type": "short_answer", "points": 1, "question": "…", "accepted": ["…"] },
    { "type": "numeric", "points": 3, "question": "…", "answer": 12.5, "tolerance": 0.1, "unit": "MPa" },
    { "type": "long_answer", "points": 5, "question": "…", "starting_text": "" },
    { "type": "code", "points": 4, "question": "…", "language": "python", "starter_code": "…" },
    { "type": "file", "points": 5, "question": "…", "allowed_types": [".pdf"], "max_size_mb": 10 },
    { "type": "text", "question": "Instructions or a heading" }
  ]
}
```

Import is lenient: it also understands `choices`, `marks`, `answer`, `prompt`,
option letters (`"correct": "B"`), option numbers (`"answer": 2` for the second),
true/false questions and JSON wrapped in other text. Questions it cannot read are
listed and left out.

Students can start an exam from its start time until the end of its duration.
Answers sent up to 10 minutes after the end are accepted and marked late.

Open **Submissions** to grade. **Autograde** marks the multiple-choice, short-answer
(with accepted answers) and numeric questions; enter points and comments for the rest. A submission
counts as graded once every question has points. The exports are **Questions**
(PDF), **Submissions** (a ZIP with a PDF per student), **Grades** (PDF) and
**Grades for EIS**: grades on the exam's base, rounded, in the order of the
pasted list, ready to paste into EIS.

| Role | Exams tab | Students tab |
|---|---|---|
| **Admin**, **Lecturer** | Everything | Everything |
| **Student** (teaching assistant) | Views exams and submissions, grades | Views |

Exam passwords are stored hashed, so a saved one can't be shown again: the editor
says that a password is saved, and typing a new one replaces it. Note it down when
you set it.

### How students sign in

| Method | How |
|---|---|
| **Google** | Their Google email must match the email on a class list. The dashboard shows their current courses with semester and academic year, then **Past courses** (archived) with their grades. |
| **Student ID** | Temporary, for taking an exam: the student ID and the password of one of their Student ID exams, from an hour before it starts until it closes. Starting that exam doesn't ask for the password again. Covers that course only and ends with the exam; other and past courses need Google. |
| **Exam ID** | Exam ID and the exam password, for anonymous exams. No name is recorded. |

Google is for the dashboard and grades, any time. To start an exam, a student
must sign in the way that exam asks for: **Student ID** exams need the student ID
and the exam password (so only those in class can start them), **Google account**
exams need Google. Students without a student ID on the list sign in with Google.
A wrong student ID or password just says so.

**Grades of anonymous exams.** Once results are published, a student chooses
**Grade** on the sign-in page (no sign-in needed), picks the course and semester,
and enters their exam ID. Signed in, each course card on the dashboard has its
own exam ID box. A lookup only searches that one course and semester, because
exam IDs are reused in other semesters. Nothing is saved, and the request is
sent without the student's session, so it is never tied to their account. Anyone
who has an exam ID can see that ID's grade in that course, though not whose it
is. Supabase's request logs do record IP addresses; in an exam hall, those are
usually the university's shared address.

**Archived courses.** Students still see an archived course under **Past
courses**, with their grades and exam ID lookups, but cannot start its exams.

### Exam database

The tables are in the private `exam_private` schema. The API does not expose
it, and it has row-level security with no policies. Everything goes through the
`public.exam_*` functions, which check the caller themselves:

1. [supabase/exams/1-schema.sql](supabase/exams/1-schema.sql): tables and helpers (applied).
2. [supabase/exams/2-functions.sql](supabase/exams/2-functions.sql): the functions the
   editor and `/exam/` call, after bringing the applied tables up to date (optional
   student ID, the Exam ID column; no attendance, saved exam IDs or class password). Run it in the
   Supabase SQL editor. It is safe to run again; run it again after each update.
3. Supabase's **Redirect URLs** must allow `https://syllabase.al/exam/`, where Google
   sign-in returns; `https://syllabase.al/**` already covers it. Google Cloud needs no
   change: Google returns to Supabase's own callback, as for the editor. Lecturer websites
   link to this address; they do not host `/exam/`.

A course's exams, class list and submissions follow it when it is archived,
restored or deleted. The editor does this right after the course moves. If that
step fails, the same browser retries it the next time an Exams or Students tab
opens.

## Maintenance

### What needs publishing?

| Change | Where to make it |
|---|---|
| People, roles, assignments or course content | Save in the admin. No website upload is needed. |
| HTML, JavaScript or CSS | Publish the changed files together, including references to renamed files. |
| Teaching permission functions or policies | Update them in Supabase before publishing code that needs them. |
| Exam functions ([supabase/exams/](supabase/exams/)) | Run the changed SQL in Supabase before publishing code that needs it. |
| EIS timetable proxy | Redeploy the Supabase Edge Function; publishing the website does not deploy it. |

The shared settings in [js/config.js](js/config.js) also apply to lecturer
websites. They keep the same copyright name and years, link Home to their own
website root, and omit the cat companion. This file is
public: service-role keys and secrets must not go in it.

The separate timetable admin still uses the `public.admins` access list.
Teaching Settings do not manage that list.

## File reference

The folders follow the page URLs: `index.html` at the root is the editor;
`courses/index.html` is the public course page. Shared scripts and styles live in
`js/` and `css/`.

### Pages and shared helpers

| File | Purpose |
|---|---|
| [courses/index.html](courses/index.html) | Public course page |
| [404.html](404.html) | Missing addresses; corrects mistyped lecturer links |
| [js/course-page.js](js/course-page.js) | Public catalog, course content, navigation and interactions |
| [js/config.js](js/config.js) | Shared service addresses, public keys, branding and theme |
| [js/sites.js](js/sites.js) | Lecturer website URLs, public data requests and download HTML |
| [js/timetable.js](js/timetable.js) | EIS timetable rendering; also used by `/timetable/` |
| [embed.js](embed.js) | Permanent loader used by uploaded lecturer files |
| [css/main.css](css/main.css) | Shared components and public course styles |

### Editor

| File | Purpose |
|---|---|
| [js/course-editor.js](js/course-editor.js) | Sign-in, course forms, permissions and saving |
| [js/course-finder.js](js/course-finder.js) | Course list on the homepage and `?admin` sign-in page |
| [js/access-settings.js](js/access-settings.js) | People, roles, assignments and website downloads |
| [js/course-exams.js](js/course-exams.js) | Exams and Students tabs: exam editor, grading, exports, class list and exam IDs |
| [css/editor.css](css/editor.css) | Editor layout and controls; also used by the timetable admin and exam page |
| [css/course-exams.css](css/course-exams.css) | Exams and Students tabs |
| [css/access-settings.css](css/access-settings.css) | Settings layout |
| [css/home.css](css/home.css) | Signed-out page: title, sign-in button and course list |

The scripts are separated by responsibility, so public pages do not load the
editor and shared helpers do not need duplicate copies. They use browser globals:
keep configuration and helpers before the page controller in the HTML.

`embed.js` reads the central HTML and loads its assets in that order. Keep its
address, supporting files, Supabase project and lecturer website IDs available
so existing uploads continue to work.

### Exams

| File | Purpose |
|---|---|
| [exam/index.html](exam/index.html) | Student exam page: sign-in, dashboard, taking an exam, results |
| [exam/js/common.js](exam/js/common.js) | Theme toggle, footer, notifications and confirm dialog |
| [exam/js/store.js](exam/js/store.js) | `examStore`: sign-in sessions and every `exam_*` call the page makes |
| [exam/js/taking.js](exam/js/taking.js) | Taking an exam: questions, timer, autosave, backup and submission |
| [exam/js/scripts.js](exam/js/scripts.js) | Dashboard, results and grades by exam ID |
| [exam/css/styles.css](exam/css/styles.css) | Exam page styles on top of `css/main.css` and `css/editor.css` |
| [supabase/exams/](supabase/exams/) | Exam tables and `exam_*` functions (see [Exam database](#exam-database)) |

### Supabase

| File | Purpose |
|---|---|
| [functions/eis-timetable/index.ts](supabase/functions/eis-timetable/index.ts) | Fetches public EIS timetables |

## Troubleshooting

| Problem | What to check |
|---|---|
| Sign-in returns to the central website | The exact lecturer admin URL is in Supabase's Redirect URLs, including `www` if used. |
| Signing in on a local test server ends on `syllabase.al` | Add the local address to Supabase's Redirect URLs, such as `http://localhost:5500/**`. |
| A lecturer folder's `?admin` still looks old when tested locally | Lecturer files load the app from `https://syllabase.al/`, so they show the published version. Publish the changes, or test the local version at `/` and `/?admin`. |
| One Tap does not appear, or the Drive picker fails | The website's origin is in the Google Cloud Console OAuth client's Authorised JavaScript origins. |
| Website download is unavailable | Save the account as Lecturer or Admin. If the problem persists, have the site administrator check the website download functions in Supabase. |
| A course is missing | Check its assignment and whether it is archived. On `/courses/`, check the main page owner's courses. |
| A lecturer is missing from a course page | Check their assignment, and that they have a name to show (see [Profiles](#profiles)). |
| A renamed script or stylesheet fails to load | Publish the referencing HTML and the renamed file together, then reload. |
| The Exams tab says the exam database functions are not installed | Run [supabase/exams/2-functions.sql](supabase/exams/2-functions.sql) in Supabase. |
| A student signs in with Google but sees no courses | Their Google email must match the email on the course's Students tab. |
| Student ID sign-in says "Wrong student ID or password" | The student must be on an active course's Students tab with that student ID, and use the password of a visible **Student ID** exam of that course, from an hour before it starts until it closes. |
| Saving students says another course has a different email or student ID | A student keeps one student ID and email in every course. Correct the paste, or the student in the other course (archived ones included). |
| Google sign-in on `/exam/` ends on the course list | Supabase's Redirect URLs must allow `https://syllabase.al/exam/` (for example through `https://syllabase.al/**`). |
