# contest-userimport

A HydroOJ addon that adds **batch user enrollment** to contests.

Instead of searching and adding participants one by one on `/contest/:tid/user`, administrators can paste a list of usernames, emails, or UIDs and enroll them all at once.

---

## Features

- **批量添加 button** injected into the existing `/contest/:tid/user` page, sitting right next to the original 添加用户 button — no core files modified
- Dedicated page at `/contest/:tid/batch-add` with a textarea form
- **Preview mode** — validates every line and shows a per-line result log without touching the database
- **Import mode** — commits the enrollment after preview
- Accepts **username**, **email**, or numeric **uid** (auto-detected per line)
- Comma- or tab-separated lines supported (only the first column is used)
- Already-enrolled users and blank lines are silently skipped
- Full i18n for Chinese (`zh`) and English (`en`)
- Requires `PRIV_EDIT_SYSTEM` — only admins can access the page

---

## File Structure

```
contest-userimport/
├── index.ts                              # Route handler + i18n registration
├── frontend/
│   └── contest_batch_user.page.ts        # Injects 批量添加 button into contest_user page
├── templates/
│   └── contest_batch_user.html           # Batch-add form template
├── package.json
└── README.md
```

---

## Installation

```bash
# Register the addon with HydroOJ
hydrooj addon add /path/to/contest-userimport

# Restart the service
pm2 restart hydrooj
```

---

## Usage

### Accessing the page

Two ways to reach the batch-add page:

1. Go to `/contest/<tid>/user` — click the **+ 批量添加** button in the top-right toolbar
2. Navigate directly to `/contest/<tid>/batch-add`

### Input format

One entry per line. Each line can be any of:

| Format | Example |
|--------|---------|
| Username | `alice` |
| Email | `alice@example.com` |
| Numeric UID | `12345` |

Comma- or tab-separated lines are accepted; only the **first column** is read. This means you can paste directly from a spreadsheet export.

```
alice
bob@example.com
12345
charlie, extra_column_ignored
```

### Workflow

1. Paste your user list into the textarea
2. Click **预览 (Preview)** — inspect the per-line log for any "not found" errors
3. Fix any errors in the list, then click **导入 (Import)** to enroll everyone

---

## Permissions

The route and button are gated behind `PRIV.PRIV_EDIT_SYSTEM`. Users without this privilege cannot see the button or access the URL.

---

## Notes

- Enrollment is performed via `ContestModel.attend()`. If your Hydro version exposes a different method for admin-side enrollment, update the call in `index.ts` accordingly.
- The frontend button injection uses `NamedPage(['contest_user'], ...)` so it only runs on the contest user management page, with no impact on any other page.

## License

This project is licensed under the AGPL-3.0-or-later license, in accordance with the Hydro OJ framework.

### Additional Terms (per Hydro AGPL-3.0-or-later)

Based on AGPL3 Section 7, when using this software, you must comply with the following additional terms:

1. Do not remove the copyright notice and attribution of this project. (__AGPL3 7(b)__)
2. When redistributing modified versions of this software, indicate the modifications in a recognizable way in the software name or version number. (__AGPL3 7(c)__)
3. Unless permitted, do not use the author's name for promotional purposes. (__AGPL3 7(d)__)

That is: When deploying Hydro, keep the "Powered by Hydro" text at the bottom, with "Hydro" linking to `hydro.js.org/this repository/fork`. If you modify/extend the source code, you must also open-source it under AGPL-3.0-or-later, and indicate in the footer as "Powered by Hydro, Modified by xxx".

For commercial closed-source usage, please contact the Hydro team to purchase alternative licensing.
