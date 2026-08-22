# Domain User Grade

Lightweight Hydro plugin for collecting a student's grade inside each domain.

## What it does

- Adds a `grade` select field to `/home/settings/domain`.
- Stores the value in the existing `domain.user` document, for example `domain.user.grade`.
- Shows the grade on the user detail page for domain admins.
- Adds a domain management page at `/domain/user-grade`.
- Exports domain users and grades as CSV from `/domain/user-grade/export`.
- Adds the grade column to contest scoreboard HTML/CSV exports.
- Clears invalid non-empty grade values that are no longer present in plugin config.

## Default Grade Options

- 小学一年级
- 小学二年级
- 小学三年级
- 小学四年级
- 小学五年级
- 小学六年级
- 初一
- 初二
- 初三
- 高一
- 高二
- 高三

The options can be changed in plugin config. Users cannot submit values outside the configured list from the normal settings form.

## Install

```bash
hydrooj addon add /path/to/domain-user-grade
```

Restart Hydro after installation.
