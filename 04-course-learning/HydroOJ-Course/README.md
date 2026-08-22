# HydroOJ-Course

Course plugin for HydroOJ v5 - Enhanced training + homework functionality for classroom use.

## Features

- **Create Courses**: Create courses with an introduction, nested chapters, problems, and file attachments
- **Nested Chapters**: Organize problems into chapters and nested subchapters, each with its own page
- **Multiple Classes**: Support for multiple classes/groups per course
- **Multiple Teachers**: Assign multiple teachers to a course
- **Student Progress Tracking**: Track individual student progress through the course
- **File/Lecture Upload**: Upload lecture materials and course files
- **Class Management**: Manage students by class/group
- **Scoreboard**: View student scores and progress
- **Cross-Domain Sharing**: Share a course to other domains (with problems and files)

## Installation

```bash
# Install from npm (when published)
yarn add @hydrooj/course

# Or install from local directory
cd /path/to/hydro
yarn add /path/to/HydroOJ-Course
```

## Permissions

This plugin uses the Homework permissions from HydroOJ:

- `PERM_VIEW_HOMEWORK` - View courses
- `PERM_CREATE_HOMEWORK` - Create courses
- `PERM_ATTEND_HOMEWORK` - Join courses
- `PERM_EDIT_HOMEWORK` - Edit any course
- `PERM_EDIT_HOMEWORK_SELF` - Edit own courses
- `PERM_VIEW_HOMEWORK_SCOREBOARD` - View course scoreboard
- `PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD` - View hidden scoreboard
- `PERM_VIEW_HIDDEN_HOMEWORK` - View hidden courses

## Routes

| Route | Path | Description |
|-------|------|-------------|
| `course_main` | `/course` | Course list |
| `course_create` | `/course/create` | Create new course |
| `course_detail` | `/course/:cid` | Course detail page |
| `course_edit` | `/course/:cid/edit` | Edit course |
| `course_files` | `/course/:cid/file` | Manage course files |
| `course_file_download` | `/course/:cid/file/:filename` | Download course file |
| `course_scoreboard` | `/course/:cid/scoreboard` | View scoreboard |
| `course_records` | `/course/:cid/records` | View records |
| `course_share` | `/course/:cid/share` | Share course to another domain |

## Sharing Courses Across Domains

Courses can be shared to other domains so that students in those domains can
join the same course and submit to the same problems. Sharing copies the course
content and files, and creates *referenced copies* of the problems in the
target domain using HydroOJ's native cross-domain problem mechanism, so:

- Students submit and get judged in their own domain, using the original
  problem's test data;
- Records and scoreboards are kept per domain;
- Problem edits in the source domain automatically apply to referenced copies;
- Re-sharing to the same domain updates the existing copy instead of
  duplicating it.

### Prerequisites

Because sharing copies problems between domains, the source domain must allow
the target domain to reference its problems. This is controlled by the domain
setting **"Share problem with domain"** (`setting_domain.share`) in HydroOJ:

- Leave empty to disable cross-domain problem copying;
- Enter a comma-separated list of domain IDs to allow only those domains;
- Enter `*` to allow all domains.

The user performing the share must have `PERM_CREATE_HOMEWORK` in the target
domain and `PERM_EDIT_HOMEWORK` / `PERM_EDIT_HOMEWORK_SELF` (or be the owner /
teacher) of the source course.

### Usage

1. Open a course and go to **Edit Course → Share to Domain** (or the share link
   in the course sidebar).
2. Pick the target domain and confirm. You will be redirected to the shared
   copy in the target domain.
3. On the share page you can manage existing shares:
   - **Sync** pushes the current title, introduction, chapters, problem list
     and files of the source course to a shared copy;
   - **Revoke** deletes the course copy in the target domain (copied problems
     are kept, as they may be referenced by other courses).

Notes:

- Class/group restrictions (`assign`/`classes`) and teachers are copied to the
  target domain; adjust them on the copy if the target domain uses different
  class names. The copy is a normal course in the target domain and can be
  edited there.
- A shared copy cannot be shared again (no chain sharing); only the source
  course can be shared.
- The share page is only reachable from the source course; shared copies show a
  "Shared from domain ..." banner linking back to the original course.

## Navigation

The course entry appears in the top navigation bar, positioned after Training and before Contest.

## Compatibility

- HydroOJ v5 beta-16 or later

## License

AGPL-3.0-or-later
