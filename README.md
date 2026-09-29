# syllabase
A central platform where lecturers publish and share course materials, syllabi and teaching resources.

This guide records how accounts, lecturer websites and updates work.
Course content and permissions are stored in one Supabase project. The central
website serves the application; lecturers display their assigned courses on
their own websites through an uploaded `index.html` file.

[Accounts](#accounts-and-permissions) · [Lecturer websites](#lecturer-websites) · [Maintenance](#maintenance) · [Files](#file-reference) · [Troubleshooting](#troubleshooting)

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
| **Student** | Assigned courses | Modules, Projects and Announcements | None |

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

- Courses are listed as a table grouped by term. Visitors can search (by code,
  name, lecturer, semester or year), switch between **Current**, **Past** and
  **All**, and pick a term or lecturer. Each course opens on its lecturer's
  page, such as `/bplaku/#CE_121`; a course with several lecturers links each of
  them, showing up to three names and then "+N more".
- **The homepage** (`https://syllabase.al/`) shows the list open with a small
  **Sign in** button below it. Each browser remembers whether the list was left
  open and its last tab, term and lecturer; search text is not kept.
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
  `css`, `js`, `favicon`, `supabase` or `miscellaneous`.

### After upload

The file loads the current application and course data. It contains a public
lecturer ID, not a password.

The initial theme styles and favicon link live in the downloaded HTML itself.
To update those in an existing upload, download and replace its `index.html` once.
The favicon comment shows where to set the website's own icon; the loader keeps it.

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

## Maintenance

### What needs publishing?

| Change | Where to make it |
|---|---|
| People, roles, assignments or course content | Save in the admin. No website upload is needed. |
| HTML, JavaScript or CSS | Publish the changed files together, including references to renamed files. |
| Teaching permission functions or policies | Update them in Supabase before publishing code that needs them. |
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
| [css/editor.css](css/editor.css) | Editor layout and controls; also used by timetable admin |
| [css/access-settings.css](css/access-settings.css) | Settings layout |
| [css/home.css](css/home.css) | Signed-out page: title, sign-in button and course list |

The scripts are separated by responsibility, so public pages do not load the
editor and shared helpers do not need duplicate copies. They use browser globals:
keep configuration and helpers before the page controller in the HTML.

`embed.js` reads the central HTML and loads its assets in that order. Keep its
address, supporting files, Supabase project and lecturer website IDs available
so existing uploads continue to work.

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
