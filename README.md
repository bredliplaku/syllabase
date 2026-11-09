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

### Signing in and out

**Each website has its own sign-in.** `syllabase.al/?manage` and the timetable
panel (`/timetable/?manage`) share one. Each lecturer's `?manage` has another,
whether it is a folder on syllabase.al (`/bplaku/?manage`) or their own website.
So different websites can use different Google accounts. **Sign in** always
asks which Google account to use.

**An hour without use signs out.** The hour counts across all tabs of that
sign-in, including closed ones. So a page opened the next day starts signed out,
even if the tab stayed open or the computer slept. Unsaved changes keep you
signed in until you save or discard them, so the timeout never loses work.

**Sign out** ends only that website's sign-in, not your other websites or
devices. It doesn't sign the browser out of Google: on a shared computer, sign
out of Google too.

### What each role can do

| Role | Courses | Editable content | Course actions |
|---|---|---|---|
| **Admin** | All, including future courses | Everything | Create, archive, restore, delete |
| **Lecturer** | Assigned courses | Everything except Course Identity and Dates | Archive |
| **Student** | Assigned courses | Modules, Assignments, Announcements and grading [exams](#exams) | None |

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
find the right course and semester, or the **Programme**, semester, year and
lecturer pills. The search matches the course code, name, semester, year, its
[programmes](#programmes) and the [lecturers](#lecturers-on-course-pages)
assigned to it. The sidebar has the same search.

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
- **Photo address:** an `https://…` image shown instead of the Google photo.
  Leave it empty to use the Google photo.

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

### Programmes

Courses belong to study programmes (`BA CE`, `MSc CE`, `PICD ARCH`…), one or
several: a course shared by two degrees belongs to both. Only Admins change them.

- **Keep the list** in Settings: **Study programmes**, below the staff, opens
  the programmes, with **Add programme** at the top and **Staff** above the list
  to go back (as does the header's back arrow, which otherwise closes Settings).
  Each has a code and a full name. **Rename** to correct one; every
  course follows. **Archived** keeps a programme
  on its courses but stops offering it for others. **Delete** only removes one made
  by mistake; its courses lose it and keep their other programmes.
- **File courses** under a programme by ticking them there, or on a course's Info
  tab (Programmes, part of Course Identity) and in the New Course dialog, where a
  programme is required. Type in the Programmes box to search: `ce` lists BA CE,
  BA CEN and MSc CE; arrows and Enter choose.

Programmes show wherever courses are listed:

| Where | What |
|---|---|
| Course header (editor, course pages) | A chip per programme, with the graduation cap, after the semester |
| Sidebar | Grouped under each programme, once the courses span two or more; courses without one under Other |
| Course page tabs | Clustered inline after each programme's code, once the lecturer's courses span two or more, so grouping adds no rows |
| Course page archive | One academic year at a time, chosen from its list (it opens on the open course's year). Its semesters sit on one row, each labelled once, and the row swipes on a phone. Each course shows once. Programme pills (All, BA CE…) narrow it to one programme when the archive spans two or more. Back (the browser's, or a phone's gesture) returns to the current courses in one step, whichever archived courses were opened; a **Back** button shows only when the archive was opened from a link, or with an accessibility setting on (reduced motion, more contrast, high-contrast colours) |
| Settings | A Programme filter, and each course's programme codes |
| Homepage course list | A Programme list beside the term, and the codes after each name |

A course shared by two programmes is listed under each. The entry you chose is
selected; the other stands back (outlined) and, when tapped, says the course is
already selected under the other programme.

Programmes are listed A–Z by code, and every search also matches their codes and
names. They are labels: their text can't be selected. They need [supabase/teaching/programmes.sql](supabase/teaching/programmes.sql),
run once in the Supabase SQL editor. It brings Stando's programmes with the same
ids, and files CE 213 and CHM 103 under BA CE as Stando does. Until then, nothing
about programmes is shown.

### Previewing a course

**Preview**, beside Archive and Delete on the course header, opens the course's
public page in a new tab, for every role. Which page depends on where you signed in:

1. On a lecturer's website: that website, when the course is one of that lecturer's.
2. Otherwise your own lecturer page, if the course is assigned to you.
3. Otherwise the page of another lecturer assigned to it.
4. Otherwise the main course page (`/courses/`), if it lists the course.

When none of these shows the course, Preview stays dimmed.

### The tab toolbar

Each tab's toolbar (Save, Add Module…) floats below the top bar as you scroll, each
button keeping its colours with a soft shadow over the cards. While it floats, Preview joins it
before the Add buttons (or the ⋯ menu). **Save** stays grey while the tab has
nothing to save, and steps out of the floating toolbar altogether.

On a phone the tabs stay on one line and swipe sideways. Rows that swipe (tabs,
header chips, course buttons, lecturer chips) fade out at an edge only while more
lies past it. Buttons grouped in a row that wraps round the ends of each line.

### Dialogs

Every dialog (the editor's, the exam page's and the timetable panel's) closes with
its ×, Escape, a click outside it or **Back**: the browser's button, a mouse's back
button, or a phone's back gesture, which closes the dialog instead of leaving the
page. A dialog with something typed in it asks before discarding it. Confirmations
answer **Cancel** the same ways. A dialog opened over another takes its size on a
computer; on a phone it reaches up to just under the other's title bar, so the
title bars of what is open read down like a tree.

### New courses

**New Course** in the sidebar asks for the Course Identity, the dates and the
lecturers. Code, title, academic year, semester and programme are required. New
courses start as Active.

**Links.** A course's link is made from its code, e.g. `CE 101` → `CE_101`. One code
can be taught to two programmes as two courses, with no need for codes like
`CEN / CE 101`: the first keeps `…/#CE_101`, and the next adds its programme,
`…/#CE_101_ECE` (the programme code's last word, or the whole code if that is taken
too). The dialog shows the link before you create the course. Adding a course never
renames another, so links already shared keep working, and `…/#CE_101?ECE` opens
`CE_101_ECE` too. A second course with the same code and programme must wait until
the first is archived.

| Step | Link |
|---|---|
| CE 101 for BA CEN, then for BA ECE | `CE_101`, `CE_101_ECE` |
| Both archived in Fall 2026–2027 | `CE_101_Fall2627`, `CE_101_ECE_Fall2627` |
| Restored | `CE_101` and `CE_101_ECE` again; when an active course holds the plain link by then, the restored one adds its programme (`CE_101_CEN`), else keeps its term |

**Dates come from the same term.** Once the academic year and semester are chosen,
the dates (start, end, holiday weeks and holiday start) are filled in from that
term's other courses, archived ones included. A term can have several sets, such as
a master's course that starts later: every set is offered under **Dates**, the most
used first, and a click fills it in. A new set is remembered by simply saving a
course with it; no set ever replaces another. Dates you type yourself are kept when
the term changes. An Admin opening the Info tab of a course without dates gets the
same choices there.

**Order everywhere:** newest academic year first, then Summer → Spring → Fall,
then course number (`CE 123`, `ARCH 203`, `CE 345`). Cross-listed codes such as
`SWE / CE 101` follow, A–Z.

### Copying from another course

When a course is taught again, open the earlier offering (archived or active) and
copy its content into an active course:

- **Modules:** a module's ⋯ menu → **Copy to…** copies it with its materials and
  fun facts.
- **Projects:** the same menu in the Assignments tab copies a project with its
  description and files. Groups are not copied: they list one offering's students.
- **Info, Weights, Links, Announcements:** the ⋯ menu at the right of the tab's
  toolbar → **Copy to…**. A table shows each item beside the target's: **Same**,
  the value the copy replaces, or — when the target has none.

| Tab | What is copied |
|---|---|
| Info | The ticked Course Identity fields (with its programmes), dates, header icon and theme colours. Academic year and semester start unticked; the dates start ticked only for a course of the same term. |
| Weights | Every assessment's weight, replacing the target's. Done marks are not copied. |
| Links | The ticked timetables and link buttons. Timetables start unticked; a link replaces the target's link with the same label. |
| Announcements | The ticked announcements, dated when copied. One replaces the target's announcement with the same title. All start unticked. |

The dialog lists the active courses you can edit, with this course's active
offering selected when there is one. The copy is what the tab shows, including
unsaved changes.

- **Placement:** a copied module or project goes right after the item it follows
  in the original course, when the target has that item, otherwise on top.
  Copying modules one at a time, in any order, keeps their order.
- **Already there:** when the target has a module or project with the same
  title, icon and subtitle, a warning offers **Cancel** or **Replace**. Replace
  swaps it, with its materials (or description and files), in the same place; a
  replaced project keeps its groups.

Copying follows the [role permissions](#what-each-role-can-do): Students can copy
modules, projects and announcements; Lecturers can also copy grading, links, the
header icon and theme colours; only Admins can copy Course Identity fields and dates.

### Files

A material or project file takes its links from the **Autofill Link** field:

- **Drive:** pick a file already in your Google Drive. **My Drive** opens at its
  top level, with folders to open. **Shared with me**, **Shared drives** and
  **Recent** are the other tabs.
- **Upload:** uploads a file from your device into a folder per course in your
  Google Drive, such as `Syllabase / CE 132 Structural Analysis (Fall 2026)`.
  Anyone with the link can then view the file, so students can open it.
- **Paste** a Google Drive or OneDrive link. It fills in as you paste, or when you
  leave the field.

These fill in the View and Download links, and the title and **Subtitle** when
they are empty. After you pick or upload a file, Google's sharing screen opens,
so you can check who can open it. To change that later without uploading again,
choose **Sharing** in the file's ⋯ menu. A file that was not picked or uploaded
here with your Google account, such as a pasted link, opens in Google Drive
instead; use **Share** there. The sharing screen needs third-party cookies, which
Safari blocks. The links fold under **Links**, which stays closed until you open
it. Each module or project remembers whether it was open, in this browser. Google
asks for permission the first time; the site only reaches the files you pick or
upload through it.

**Subtitle** suggests file types as you type: `pdf`, `slides`, `.dwg` or
`lab rep` find PDF Document, Lecture Slides, AutoCAD Drawing and Lab Report
Template. Picking one, or typing one in full, also sets the **Icon**, unless you
chose that icon yourself. The list of types is in [js/suggest.js](js/suggest.js).

**PigeonFiles submissions:** a module's or project's **Add** menu →
**PigeonFiles submission** adds a card where students upload their work through
[PigeonFiles](https://pigeonfiles.com/). Create an upload page there with the same
file types, max file size and expiration date, copy its **Share link**
(`https://pigeonfiles.com/u/…`) into the card, and add the file name format, the
accepted file types (empty for all files; `pdf, .docx` shows as PDF, DOCX), the
max file size (a number alone means MB) and the deadline. A link of another shape
gets a warning but is kept. The course page shows these under a **Submit**
button, with the time left or **Closed**. PigeonFiles' embedded upload box needs a
paid plan, so the card links to the upload page instead. `pigeonUrl` in
[js/config.js](js/config.js) is where the form's **Open PigeonFiles** link goes.

### Project groups

A group's **Leader** and **Members** suggest names from the course's class list
(the [Students tab](#exams)) as you type, or as a list when the field is empty.
Students already in a group of the same project are left out. EIS's **R** or
**R EX** status, from the student's note, goes after the name, and the course page
shows it in orange. Picking a name moves on to the next empty member. Below the
members, a line says how many students are not in a group yet.

### Icons and timetables

**Icons:** wherever an icon is chosen (a module, material, link, announcement, the
header icon, the timetable panel), type a Font Awesome class such as
`fa-solid fa-circle-user` or paste the `<i class="fa-solid fa-circle-user"></i>`
tag that Font Awesome copies; the tag becomes its class. The preview beside the
field follows as you type. New modules start with `fa-solid fa-folder`.

**Timetables** on the Links tab have the timetable panel's two buttons:

- **Preview** shows the timetable below its card, from the IDs typed there, as the
  course page shows it. Changing an ID reloads it.
- **Hide** keeps the timetable but leaves it off the course page. Save the tab to
  apply either change.

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
| Manage / Sign In | `https://example.com/academic/?manage` |

The host must serve the file as a web page. The public page works without
registering its address. The upload creates no `/academic/manage/` folder;
the Sign In button opens `?manage` on the same website.

### 2. Allow sign-in

Each new website is registered in two places. Use the HTTPS address the browser
actually ends up on, and add the `www` version separately if visitors use it.

| Where | What to add | Needed for |
|---|---|---|
| **Supabase** → Authentication → URL Configuration → Redirect URLs | The full manage address, including the folder and `?manage` | Sign-in (required) |
| **Google Cloud Console** → APIs & Services → Credentials → the existing OAuth client → Authorised JavaScript origins | The origin only, with no folder or path | The Drive picker and uploads (optional) |

For the example above, the entries are:

```text
Supabase:      https://example.com/academic/?manage
               https://www.example.com/academic/?manage
Google Cloud:  https://example.com
               https://www.example.com
```

Add exact addresses, without broad wildcards, and keep the project's existing
**Site URL**. An unapproved return address may send the person to the Site URL instead.

**Without the Google Cloud origin**, the Sign In button and pasted Drive links
still work, but the Drive picker cannot open. Uploads also need the **Google
Drive API** turned on once in the same Google Cloud project (APIs & Services →
Library), for all websites. Lecturer websites never show
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
  itself that is the homepage course list. On `?manage`, the footer's **Back**
  arrow returns to the lecturer's course page; it is left out when that page is
  the domain root too (a file at `https://example.com/`), where Home already goes.
- The pages share one browser origin, but each lecturer's `?manage` keeps its
  own sign-in (see [Signing in and out](#signing-in-and-out)).

### Lecturer folders on syllabase.al

Name the folder after the lecturer's email handle, such as `bplaku/` for
`bplaku@epoka.edu.al`, and upload their downloaded `index.html` into it. The
homepage then lists their courses under **Browse courses**, with no other step.
For their **Sign In** (`/bplaku/?manage`), register `https://syllabase.al/**`
once, as in [Several lecturers on one domain](#several-lecturers-on-one-domain).

- Courses are listed as a table grouped by term, each term with its number of
  courses. Visitors can search (by code, name, lecturer, programme, semester or
  year), switch between **Current**, **Past** and **All**, and pick a programme,
  term or lecturer.
  <kbd>/</kbd> jumps to the search, and <kbd>Enter</kbd> opens the course when
  the search leaves exactly one.
- Each course opens on its lecturer's page, such as `/bplaku/#CE_121`. A row
  shows its lecturers' photos and names; a course with several lecturers links
  each of them, showing up to three names and then "+N more".
- **The homepage** (`https://syllabase.al/`) links to the class timetable under
  its title, shows the list open, and has a small **Sign in** button below it.
  Each browser remembers whether the list was left open and its last tab, term
  and lecturer; search text is not kept.
- **`?manage`**, on the homepage or a lecturer's website, shows a large **Sign
  in** button above the closed list; it remembers its own open state. A
  lecturer's `?manage` starts on that lecturer's courses. Filters chosen on
  `?manage` are not saved, so the homepage keeps its own.
- Google's One Tap prompt appears only on `https://syllabase.al/?manage`, never
  on the homepage or on lecturer websites.
- Every lecturer of a course is named; a name links to that lecturer's page once
  their folder holds their own file (folders named differently are not found).
  A course opens on one of those pages, so a course none of whose lecturers has a
  page is left out.
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

**The cat companion** is off on lecturer websites unless their file asks for it.
To show it, add `data-teaching-cat` to the `embed.js` script tag in the uploaded
`index.html`:

```html
<script defer src="https://syllabase.al/embed.js"
  data-teaching-lecturer="…" data-teaching-cat></script>
```

The cat then follows `catCompanion` in [js/config.js](js/config.js), as on
`syllabase.al`. It never appears on `?manage`. Downloaded files leave the
attribute out, and a page without it never shows the cat, even briefly.

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

The student list comes last on the tab, 10 students a page, with a search box
that looks through every page. Teaching assistants can search it and page
through it too.

Click a row to select it; Ctrl/Cmd+click and Shift+click select several, and
Ctrl/Cmd+A all of them once one is selected (on a phone, use the checkboxes).
**Select all**, Ctrl/Cmd+A and Shift+click ranges take every student the search
finds, on every page.
**Edit** changes one student, or the programme of several at once; **Delete**
(or the Delete key) removes them. Each row and each exam ID also has its own
edit button. A student's **Exam ID** column is only a note for finding someone:
it does not sign them in or link their results. These changes save at once.

### Create and grade an exam

**New exam** (and an exam's Edit) is one compact form. The **Assessment** is an entry
from the **Weights** tab (Quiz 1, Midterm 1, Final…), which fills in the label, type and
weight, or **Custom** to fill them in yourself; then the base (100 by default), hall,
date, time and duration (with when it ends under it). **Sign-in** is **Student ID** by
default; midterm, final, resit and additional exams default to **Exam ID (anonymous)**.
Both sign in with the exam password, so they need one once the exam has questions (a
card without one says so, with a link to set it); with **Google account** it is
optional. Four switches close it: **Shuffle questions**, **Lock on leaving** (below),
**Published** and **Grades released**. **Add exam** then opens the exam's questions. An
exam without questions (held on paper) is only listed.

| Switch | Off | On |
|---|---|---|
| **Published** | A draft only lecturers see. | Students see it on their dashboard and the course page, and can start it when it opens. |
| **Grades released** | Grades stay hidden while you grade. | Students see their grade, answers, comments and feedback. |

With an assessment chosen, turning on **Grades released** marks that
entry **Done** on the Weights tab and locks it there (its Done and remove
controls): set the exam's Assessment to **Custom** to change it. When the Weights
tab renumbers entries (removing Quiz 1 makes Quiz 2 the new Quiz 1), exams follow
their entry; an exam whose entry was removed becomes Custom.

While students take it, the exam page always shows their name and student ID (the exam
ID on anonymous exams) large and faint down the left side of the screen, over the
questions: readable from the back of the room, and on any photo of the screen.
Leaving the page means clicking outside the window, another tab or another program:

| Lock on leaving | What students see |
|---|---|
| **On** (default) | When they come back, the screen turns red and the exam stays locked for the seconds beside the switch (15 by default, the same each time), while the timer keeps running. |
| **Off** (recorded only) | Nothing: for exams that need other programs, such as AutoCAD or an IDE. |

Either way, each time a student leaves is recorded with their submission, and the
start dialog tells them the rule. Picking a file for a file question doesn't count
(unless the file chooser stays open over 3 minutes). A reload or a closed page is
recorded, with a countdown only after more than 5 seconds; a countdown that was
running carries on after a reload, where it was. The questions editor warns when an
exam with file or code questions has the countdown on. This deters and records; it
can't see a phone.

### Questions

The Exams tab lists the exams in aligned rows: the name (with its status, type,
weight and sign-in under it), the date and place, how many submitted and are left to
grade, the **Published** and **Grades released** switches, **Grades** (filled, with how
many are left, while any are), and ⋯ for
Questions, Settings, Preview, the exam paper, Duplicate and Delete. An exam's name
opens its questions. Inside an exam, the switch beside **All exams** goes between its
**Questions** and its **Grades**; the questions' bar has **Add question**, ⋯ (Preview,
Settings, Select, Fold all, points, Import, Export, the exam paper) and **Save**. Add a
question with **Add question**, one type at a time:

| Type | Students answer with | Autograding |
|---|---|---|
| **Multiple choice** | One of the options (a new question starts with four); with **Add “Other”**, also their own answer, written in | Right when the chosen option is ticked as correct; an answer under Other by hand |
| **Short answer** | A line of text | Right when it matches an accepted answer (capitals and spaces ignored); none listed means by hand |
| **Numeric** | A number, with the unit beside it | Right when within the tolerance (± 0 by default) |
| **Long answer** | A text box, optionally with starting text | By hand |
| **Code** | A code editor, optionally with starter code | By hand |
| **File upload** | A file of the allowed types (e.g. `.dwg`), up to 50 MB, uploaded as soon as it is chosen | By hand |
| **Information** | Nothing: instructions or a heading | Not graded |

**Formatting.** The toolbar above a question's text sets bold (Ctrl+B), italic
(Ctrl+I), underline (Ctrl+U), superscript (m²), subscript (H₂O), code, bulleted and
numbered lists, and inserts symbols (Ω, μ, π, ±, °, ≤…). It writes marks into the text
(`**bold**`, `*italic*`, `__underline__`, `m^2^`, `H~2~O`, `` `code` ``, lines starting
`- ` or `1. `), which can also be typed; **Shows as** under the text shows the result.

**Images.** Any question can show images below its text (a drawing to reproduce, a
figure): **Image** in the toolbar, paste a screenshot (Ctrl+V) in the text, or drop an
image on the question. They are scaled down (2000 px at most) and kept in the database
beside the questions, not on Drive: students get them only with the exam, once it
has started, with no link to pass on, and nothing is saved on their device. A
click shows an image at the size of the screen. Duplicated exams keep their images.

Drag the handle (or use the arrows) to reorder; duplicate, delete and collapse
cards from their header. In options, Enter adds the next one, and pasting several
lines adds one option per line. An optional **Explanation** is shown to students
with their grade. **Preview** (also on the exam's card) opens the real exam page in
a new tab, with the questions as they are in the editor: the timer, uploads (checked,
not uploaded), the watermark and the leaving rule, any time, without publishing or
opening the exam. Nothing is saved or sent, and it
ends with what would have been submitted; keep the editor's tab open while trying.
**Save** (or Ctrl/Cmd+S) checks each question and stores them; leaving
with unsaved changes asks first. Once students have submitted, don't reorder or
remove questions: answers are matched by position.

**Import and export.** **Export** downloads the questions as JSON, with their
images inside. **Import** takes such a file, pasted JSON, or another exam of the
course, adding to or replacing the current questions after a preview. For another professor's exam,
choose **Copy instructions for Claude** in Import, give Claude those instructions
with the exam (PDF, Word or text), and paste its reply. The format:

```json
{
  "format": "syllabase-questions",
  "version": 1,
  "questions": [
    { "type": "multiple_choice", "points": 2, "question": "…", "options": ["…", "…"], "correct": ["…"], "other": true, "explanation": "…" },
    { "type": "short_answer", "points": 1, "question": "…", "accepted": ["…"] },
    { "type": "numeric", "points": 3, "question": "…", "answer": 12.5, "tolerance": 0.1, "unit": "MPa" },
    { "type": "long_answer", "points": 5, "question": "…", "starting_text": "" },
    { "type": "code", "points": 4, "question": "…", "language": "python", "starter_code": "…" },
    { "type": "file", "points": 5, "question": "…", "allowed_types": [".pdf"], "max_size_mb": 10 },
    { "type": "text", "question": "Instructions or a heading" },
    { "type": "short_answer", "module": "Torsion", "link": "A", "question": "…" },
    { "type": "short_answer", "module": "Torsion", "link": "A", "question": "…" }
  ]
}
```

Import is lenient: it also understands `choices`, `marks`, `answer`, `prompt`,
option letters (`"correct": "B"`), option numbers (`"answer": 2` for the second),
true/false questions and JSON wrapped in other text. `"other": true` adds Other to a
multiple-choice question. Questions it cannot read are
listed and left out.

### Question pools

**Question pool** (on the Exams tab, beside **New exam**) holds the course's questions
for every semester it is taught: archived offerings (`CE_121_Fall2526`) share the pool of
`CE_121`. It has a section per module, in the Modules tab's order (then modules the
pool names from other semesters, then questions without one), each with its own
**Add question**. Pool questions have no points, and move to another module by
dragging or with their **Module** field. **Import** fills the pool from a file, from
Claude or from the course's exams (into the module chosen, or the one the file names);
**Export** keeps the modules and links. Pool questions have no numbers: their order
means nothing.

**A long pool.** A module folds and opens from its heading (this browser remembers
which, per course; a pool of more than 20 questions starts folded). Each module shows
15 questions a page, with its pages under it; a linked set is never split between
pages. Every question stays on the page, out of sight, so dragging to another module
(a folded module opens a strip to drop in), linking across pages and modules, and
saving work as before. **Search the pool** shows the questions whose text, options or
answers match, in every module.

**Linked questions.** A question's link button, then another's, links the two (and
their sets): a student gets one of them at most. Use it for questions that are alike,
or that give each other away. Linked questions stay together in their module, under a
line that says so. **Unlink it** takes a question out of its set. In a file, linked
questions share a `"link"` name (`"link": "A"`); importing into the pool makes each
name a new link, so it never joins the pool's own.

**In an exam**, **Add question › From the pool** adds a pool item: *draw 5
questions, 2 points each*, from the modules and types ticked (none ticked: all).
**One student's questions** shows a draw, and **‹ ›** another student's; a question
can be left out of this exam there, or in **All questions that fit**, and linked
there too (that link is saved in the pool at once). Pool items and the exam's own
questions mix in any order. Each student draws their own questions when they start
(kept with their attempt, so a reload or another device gets the same), never the same
question twice in an exam, and never two of a linked set. **Every student gets exactly the
number of questions asked for.** The pool items with the least to spare draw first, and
when an item is still short (another item over the same modules, or a linked set, took
what it needed), questions move between the items until each has its count. An exam whose
pool items ask for more than the pool can give, together, says so on the item and can't
be saved. While the exam runs, a fix
to a pool question reaches the students who drew it; a question removed from the pool
is replaced. A submission keeps the questions as the student had them, whatever later
happens to the pool: its grading page, autograde, reports and the ZIP use them, each
drawn question marked with its module. A grade entered without a submission is graded
as a whole. The exam paper prints one student's draw of each pool item: its **Variant**
picks which.

Students can start an exam from its start time until the end of its duration.
Answers sent up to 10 minutes after the end are accepted and marked late. When
time runs out, the exam is sent automatically with only the confirmed answers.
Students are reminded as the timer turns orange and as it turns red if any question is
still unconfirmed.

**Taking it.** Each question reads as on the paper: a head with QUESTION and its number,
the points and Confirm, then its text at the full width (justified), then the answer. True
or false statements together are a line each, True in green and False in red once chosen.
The questions (their text, the options and what students type) are set in Merriweather, a
serif made for reading on screens; the controls keep the site's font. The top bar has the
exam's name, the timer with the count
of confirmed answers in its middle (a press goes to the next question to confirm), and
Sign out. By the share of the exam left, the timer and the page turn yellow at 30%, orange
at 15% and red at 7%, the timer pulsing: a 10-minute quiz turns orange at 1.5 minutes,
a 2-hour exam at 18. It runs on the server's clock, not the computer's: a computer set to
the wrong time or time zone shows the right time left, never more than the exam's length.
Each question's **Confirm** switch (at its top right, with the points) shows once there is
an answer (an option chosen, something typed, a file uploaded) and fades out again if it is
taken away, in a place kept for it so nothing moves. It folds the answer away, so it is out
of sight, also from the neighbours, and switched off opens it again; the question's text
stays as it is. Enter in a one-line answer confirms it too. A second click on the chosen
option, or on True or False, clears it; an uploaded file has **Remove** (the file stays
with the uploads, shown to you as not confirmed). With Other, writing in its box chooses
it. Questions
that show the same figure stay together, under it (shuffled or not), as true or false and
multiple-choice questions in a row do. **Submit exam** with answers not confirmed warns
which ones will not be sent, with **Submit anyway** or **Go to it**. Leaving the page
shows the seconds left in large red figures on the red screen, with a no-entry cursor. The
course pages' cat keeps the student company.

**A reload, a reboot, a lost connection.** The exam is saved on the computer as the
student works, so a reload (or the computer starting again) comes back to the same
answers, confirmations, countdown and place on the page. A submitted exam is not
opened again, nor one that no longer takes answers. Back after the end (within
those 10 minutes), the saved answers are sent, as at the deadline, without opening
the exam. Without a connection, a submission waits on the computer and goes as soon
as it is back.

Open **Grades** to grade. While the exam is open (and 15 minutes after), the list
refreshes itself every 30 seconds. **Autograde** marks the multiple-choice, short-answer
(with accepted answers) and numeric questions; enter points and comments for the rest. A submission
counts as graded once every question has points. Closing the grading page with
points or comments not saved asks first. **Save and next** (Ctrl+Enter) opens the next
student at once. Each row has one button, the same size in every row: **Grade** (filled:
work to do), **Review** (graded), **Enter grade** (dashed: no submission, once the exam
has closed) or **Feedback** (an exam held on paper).

Exports work at any time, graded or not:

| Export | What it has |
|---|---|
| **Grades for EIS** | Names (exam IDs for anonymous exams) and grades on the exam's base, to two decimals as EIS takes them (72.35, 72.4 or 72), in the order of the pasted list. **Copy names and grades** copies them under the headings Name and Total, **Copy grades** under Total. Partly graded submissions count the points given so far (marked); no grade yet is blank. |
| **Export › Grades (PDF)** | The grade report to sign: everyone on the class list, partly graded grades marked with \*, no submission or not graded said so. |
| **Export › Graded exams (PDF)** | Each submission in the exam form (below): the cover with the student written in and the grade, points and feedback, then the questions with their answers, points and comments so far. The grading page's Download and the ZIP's PDFs are the same. |
| **Export › Submissions (ZIP)** | A PDF per student and the files they uploaded. |
| **Export › Exam paper (PDF)** | The questions to print, in the university's exam form; also from the exam's ⋯. |

**The exam paper** follows the form EU-FRM-010-002: a cover with EPOKA University in text, the faculty
and department, the course and the exam, the exam ID boxes (anonymous exams) or the
student's name and student ID boxes, the date, time, hall and lecturer, the exam rules
and Good luck; then the questions, each page headed with EPOKA University and the faculty,
department and course, with the form's code and the page number at its foot. True or
false and multiple-choice questions in a row make one question in parts (I, II…), with
TRUE | FALSE to circle and the options in columns; questions on one figure print it once; marks show as a share of the exam
(/20%) or as points. Written questions start a page of their own, the rest of it for
the working (or get the space chosen). Images are printed. **Answer key** prints the
same paper with the answers circled and written in blue, and the explanations under
written questions. Other prints as the last option with a line to write on. The faculty, department, rules and form code are kept in the
browser per course; **Group** prints at the cover's foot. Graded exams use the same
form: the answers in blue, the right ones in green, each question's points in green
(full), red (none) or blue (part).

**Left page** shows how often each student left the exam page and for how long;
click it for when and how (another tab, another program, a reload).

**Network and device** shows where each submission was made from. The database
records the IP address of every start, check-in, upload and submission (from
Cloudflare's header, which a browser can't fake), with the device and browser. The
**class network** is the address most submissions came from: a submission made
(even partly) from another one says so. Click it for each network with its
internet provider and place (looked up at ipwho.is when you open it, so your browser
sends those addresses there; a university network shows as its provider), the times
and number of check-ins, the device's screen, time zone, language and graphics, and
a warning when the same browser took the exam for another student. Web pages can't
see Wi-Fi names (SSID) or an exact location. Students are told that their network
and device are recorded. In grading,
a file answer has **Download**. Uploaded files are in Supabase Storage, whose free
plan holds 1 GB in all: once you have the Submissions ZIP, **Delete files** frees
the space (grades and the other answers stay). Deleting an exam deletes its files.

| Role | Exams tab | Students tab |
|---|---|---|
| **Admin**, **Lecturer** | Everything | Everything |
| **Student** (teaching assistant) | Views exams and submissions, grades | Views |

Exam passwords are stored hashed, so a saved one can't be shown again: the editor
says that a password is saved, and typing a new one replaces it. Note it down when
you set it.

### How students sign in

Students use **Syllatest**, the exam page at `/exam/`. Nothing on it can be selected
(except in the fields they type in), and the right-click menu is off.

| Method | How |
|---|---|
| **Google** | Their Google email must match the email on a class list. The dashboard shows their current courses with semester and academic year, then **Past courses** (archived) with their grades. |
| **Student ID** | Temporary, for taking one exam: the student ID and that exam's password, from an hour before it starts until it ends. Not once the student has submitted it (unless you hand it back), and not after the end: changing the exam's time opens it again. It opens only the exam whose password was used: another exam (one at the same time, say) needs a sign-in with its own password. Starting that exam doesn't ask for the password again, and when it is open, Start opens at once. The sign-in ends with the exam; other and past courses need Google. A refused sign-in says why: not open yet (with when), over, or already submitted. |
| **Exam ID** | Exam ID and the exam password, for anonymous exams. No name is recorded. |

Google is for the dashboard and grades, any time. To start an exam, a student
must sign in the way that exam asks for: **Student ID** exams need the student ID
and the exam password (so only those in class can start them), **Google account**
exams need Google. Students without a student ID on the list sign in with Google.
A wrong student ID or password just says so.

**One device at a time.** While a student ID sign-in or an exam is open, the page
checks in every 30 seconds, with the answers so far. Another computer can't sign in
with that student ID, or open that exam (or that exam ID), meanwhile: it is told to
sign out on the other device first. This is per student, so students who use one
lab computer in turn don't block each other. If that computer crashed, another one can take
over 2 minutes after it went silent, and carries on from the answers it last sent;
the move is recorded with the submission. Signing out frees the computer at once.
A student ID sign-in ends after 30 minutes without the page checking in, and the
page signs anyone out after 30 minutes without a click or a key (not during an
exam). This stops two people using one student ID or exam ID at once; it can't
tell where a computer is (see **Network and device** below).

**Shared computers.** Submitting signs the student out, so the next student at the
computer starts at the sign-in card. An exam whose page has been gone for more than
2 minutes (the computer off, the browser closed) is not opened again until someone
signs in: the student signs in again (or enters the exam ID and password again) and
carries on with the answers saved on that computer. A quick reload carries on at once.

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
   student ID, the Exam ID column; no attendance, saved exam IDs or class password;
   exam settings, the leave record, question images, uploads). It also creates the
   private Storage bucket `exam-uploads` and its policies: students can put a file
   only where `exam_upload_start` allowed it, for that exam while it takes answers;
   the course's lecturers, admins and assistants read the files, and its lecturers
   and admins delete them. Run it in the Supabase SQL editor. It is safe to run
   again; run it again after each update, and publish the website at the same time
   (not during an exam): the exam page and the functions must match.
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
| Programmes ([supabase/teaching/programmes.sql](supabase/teaching/programmes.sql)) | Run it once in Supabase; the website hides programmes until then. |
| EIS timetable proxy | Redeploy the Supabase Edge Function; publishing the website does not deploy it. |

The shared settings in [js/config.js](js/config.js) also apply to lecturer
websites. They keep the same copyright name and years and link Home to their own
website root. They show the cat companion only if their file opts in with
`data-teaching-cat` (see [After upload](#after-upload)); `catCompanion` then
applies to them too. This file is public: service-role keys and secrets must not
go in it.

The separate timetable panel still uses the `public.admins` access list.
Teaching Settings do not manage that list.

### Installing as an app

Browsers offer to install the site as an app (Chrome's and Edge's Install, Safari's
Add to Home Screen). [favicon/site.webmanifest](favicon/site.webmanifest) opens
the homepage; [favicon/exam.webmanifest](favicon/exam.webmanifest), linked from
`/exam/`, installs **Syllatest**, which opens the exam page. Lecturer folders use
[favicon/epoka/site.webmanifest](favicon/epoka/site.webmanifest), which has no
start address on purpose: each folder installs as an app opening on itself. Each
manifest needs its 192 and 512 pixel icons listed with `"purpose": "any"`;
`maskable` alone is not enough for Chrome.

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
| [js/manage-loader.js](js/manage-loader.js) | Mounts another page at an address: the editor as Syllatest (`exam/manage/`), and the timetable panel (`timetable/manage.html`) at `/timetable/?manage` |
| [js/not-found.js](js/not-found.js) | The site's 404 page for addresses that are not pages: `?admin`, or `timetable/manage.html` opened on its own |
| [js/timetable.js](js/timetable.js) | EIS timetable rendering; also used by `/timetable/` and the editor's previews |
| [js/icons.js](js/icons.js) | Icon fields: `<i>` tags to classes, live previews; editor and timetable panel |
| [js/skeleton.js](js/skeleton.js) | Picks each page's loading skeleton before it paints: signed in or out, and the course's colour |
| [js/rows.js](js/rows.js) | Rows that swipe sideways fade at an edge with more past it; wrapped button groups round each line's ends |
| [js/pick.js](js/pick.js) | Dropdown lists in the site's style on every page: opening a select shows its options in a rounded list (keyboard, typing and touch work) while the select keeps the value |
| [js/dialogs.js](js/dialogs.js) | Dialogs on the editor, exam page and timetable panel: Escape, a click outside, the × and Back close the top one (asking before typed changes are lost); stacking and sizes |
| [embed.js](embed.js) | Permanent loader used by uploaded lecturer files |
| [css/main.css](css/main.css) | Shared components, public course styles and the loading skeletons' colours and motion |

### Editor

| File | Purpose |
|---|---|
| [js/course-editor.js](js/course-editor.js) | Sign-in, course forms, permissions and saving |
| [js/course-finder.js](js/course-finder.js) | Course list on the homepage and `?manage` sign-in page |
| [js/access-settings.js](js/access-settings.js) | People, roles, assignments and website downloads |
| [js/suggest.js](js/suggest.js) | Suggestion lists under fields, and the file types the Subtitle suggests |
| [js/course-exams.js](js/course-exams.js) | Exams and Students tabs: exam editor, grading, exports, class list and exam IDs |
| [css/editor.css](css/editor.css) | Editor layout and controls; also used by the timetable panel and exam page |
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
| [exam/js/store.js](exam/js/store.js) | `examStore`: sign-in sessions, every `exam_*` call the page makes, and file uploads |
| [exam/js/integrity.js](exam/js/integrity.js) | While an exam is taken: the name watermark, leaving the page and the countdown |
| [exam/js/taking.js](exam/js/taking.js) | Taking an exam: questions and their images, file answers, timer, autosave, backup and submission |
| [exam/js/scripts.js](exam/js/scripts.js) | Dashboard, results, grades by exam ID, and previews from the course editor |
| [exam/css/styles.css](exam/css/styles.css) | Exam page styles on top of `css/main.css` and `css/editor.css` |
| [supabase/exams/](supabase/exams/) | Exam tables and `exam_*` functions (see [Exam database](#exam-database)) |

### Supabase

| File | Purpose |
|---|---|
| [functions/eis-timetable/index.ts](supabase/functions/eis-timetable/index.ts) | Fetches public EIS timetables |
| [teaching/shown-photo.sql](supabase/teaching/shown-photo.sql) | Profile photo: the photo address, else the Google photo |
| [teaching/programmes.sql](supabase/teaching/programmes.sql) | Study programmes, a course's programmes, and Stando's programmes copied with the same ids |

## Troubleshooting

| Problem | What to check |
|---|---|
| Sign-in returns to the central website | The exact lecturer manage URL (`…/?manage`) is in Supabase's Redirect URLs, including `www` if used. |
| Signing in on a local test server ends on `syllabase.al` | Add the local address to Supabase's Redirect URLs, such as `http://localhost:5500/**`. |
| A lecturer folder's `?manage` still looks old when tested locally | Lecturer files load the app from `https://syllabase.al/`, so they show the published version. Publish the changes, or test the local version at `/` and `/?manage`. |
| One Tap does not appear, or the Drive picker fails | The website's origin is in the Google Cloud Console OAuth client's Authorised JavaScript origins. |
| Drive, Upload or Sharing says Google's window was blocked | Allow pop-ups for the website in the browser, then try again. Google asks for Drive access in that window. |
| Uploading says the Google Drive API is turned off | Turn on the Google Drive API in the Google Cloud project (APIs & Services → Library). |
| An upload is not shared | Google Workspace may block "Anyone with the link" sharing. Share the file in Google Drive, or ask the Workspace admin. |
| Website download is unavailable | Save the account as Lecturer or Admin. If the problem persists, have the site administrator check the website download functions in Supabase. |
| A course is missing | Check its assignment and whether it is archived. On `/courses/`, check the main page owner's courses. |
| Settings lists no Programmes and courses show none | Run [supabase/teaching/programmes.sql](supabase/teaching/programmes.sql) in Supabase. |
| A lecturer is missing from a course page | Check their assignment, and that they have a name to show (see [Profiles](#profiles)). |
| A renamed script or stylesheet fails to load | Publish the referencing HTML and the renamed file together, then reload. |
| The Exams tab says the exam database functions are not installed | Run [supabase/exams/2-functions.sql](supabase/exams/2-functions.sql) in Supabase. |
| A student is told they are signed in on another device | They should sign out there. If that computer crashed, they can sign in on another one 2 minutes after it stopped. |
| A student's upload is refused by a security policy, or Add image fails | Run [supabase/exams/2-functions.sql](supabase/exams/2-functions.sql) again: it creates the images table, the `exam-uploads` bucket and its policies. |
| A student signs in with Google but sees no courses | Their Google email must match the email on the course's Students tab. |
| Student ID sign-in says "Wrong student ID or password" | The student must be on an active course's Students tab with that student ID, and use the password of a visible **Student ID** exam of that course, from an hour before it starts until it closes. |
| Saving students says another course has a different email or student ID | A student keeps one student ID and email in every course. Correct the paste, or the student in the other course (archived ones included). |
| Google sign-in on `/exam/` ends on the course list | Supabase's Redirect URLs must allow `https://syllabase.al/exam/` (for example through `https://syllabase.al/**`). |
