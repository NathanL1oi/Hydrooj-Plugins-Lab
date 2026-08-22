# hydro-userimport-domain
导入用户时顺便指定加入的域及角色，实现大批量导入新用户

# userimport-domain

A Hydro OJ addon that extends user import with domain enrollment and role assignment.

## Features

- Batch import users from a textarea, same as the built-in `/manage/userimport`
- Supports an extended format with **domain** and **role** columns
- Domain can be specified by **internal ID** (e.g. `system`) or **display name** (e.g. `c++`)
- Role is validated against the domain's actual role list before import
- Preview mode shows exactly what will be imported before committing
- Adds an entry to the Control Panel sidebar

## URL

```
/manage/userimport-domain
```

Also accessible from the **Control Panel** sidebar as **导入用户（域+角色）** / **Import User (Domain+Role)**.

## Input Format

Comma or tab separated, one user per line:

| Columns | Format                                                 |
| ------- | ------------------------------------------------------ |
| 3       | `email, username, password`                            |
| 4       | `email, username, password, domain`                    |
| 5       | `email, username, password, domain, role`              |
| 6       | `email, username, password, displayName, domain, role` |

- **domain**: domain `_id` (e.g. `system`) or display name (e.g. `c++`) — both work
- **role**: any role defined in that domain (e.g. `stu`, `default`); defaults to `default` if omitted
- **displayName**: optional display name shown in the domain (6-column format only)

## Examples

```
# Create user only (no domain)
foo@example.com,user1,password1

# Create and enroll in domain with default role
foo@example.com,user1,password1,system

# Create and enroll with specific role (most common)
foo@example.com,user1,password1,system,stu
foo@example.com,user1,password1,c++,stu

# Create with display name and enroll
foo@example.com,user1,password1,Alice,system,stu
```

## Usage

1. Go to `/manage/userimport-domain` or click **Import User (Domain+Role)** in the Control Panel sidebar
2. Paste your user list into the textarea
3. Click **Preview** to validate — check the output for any errors
4. If preview looks correct, click **Import**

## File Structure

```
user-import-with-domain/
  index.ts                        ← main plugin file
  package.json
  templates/
    userimport_domain.html        ← page template
```

## index.ts (working version on server)

The key implementation details:

- Validators (`isEmail`, `isUname`, `isPassword`) are defined inline as regex functions — they are NOT exported from the `hydrooj` package
- Models are accessed via `global.Hydro.model.user` and `global.Hydro.model.domain` inside handler methods — NOT imported at module level
- `db.collection('domain')` is called at module level (safe, db is connected by load time)
- Domain resolution tries `DomainModel.get(input)` first (matches `_id`), then falls back to `collDomain.findOne({ name: input })` (matches display name)
- Route is registered as a new URL — does not attempt to override the built-in `/manage/userimport`
- Sidebar entry added via `ctx.injectUI('ControlPanel', ...)` which feeds into `ui.getNodes('ControlPanel')` in `manage_base.html`

## Installation

```bash
hydrooj addon add /path/to/user-import-with-domain
pm2 restart hydrooj
```

## Troubleshooting

| Error                                                        | Cause                                                        | Fix                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `Cannot read properties of undefined (reading 'validator')`  | Used `global.Hydro.lib.validator` — undefined in this version | Use inline regex validators                                  |
| `(0, import_hydrooj.isEmail) is not a function`              | `isEmail` not exported from `hydrooj` package                | Use inline regex validators                                  |
| `Cannot read properties of undefined (reading 'getByEmail')` | Imported `user as UserModel` from `hydrooj` — undefined      | Use `global.Hydro.model.user` inside handler                 |
| `Addon load fail`                                            | Wrong entry filename (`handler.ts` instead of `index.ts`)    | Cordis-based Hydro loads from `index.ts`                     |
| Plugin loads but `apply` never called                        | Top-level `db.collection()` crash at require-time            | Move db calls inside `apply()` or handler methods            |

## License

This project is licensed under the AGPL-3.0-or-later license, in accordance with the Hydro OJ framework.

### Additional Terms (per Hydro AGPL-3.0-or-later)

Based on AGPL3 Section 7, when using this software, you must comply with the following additional terms:

1. Do not remove the copyright notice and attribution of this project. (__AGPL3 7(b)__)
2. When redistributing modified versions of this software, indicate the modifications in a recognizable way in the software name or version number. (__AGPL3 7(c)__)
3. Unless permitted, do not use the author's name for promotional purposes. (__AGPL3 7(d)__)

That is: When deploying Hydro, keep the "Powered by Hydro" text at the bottom, with "Hydro" linking to `hydro.js.org/this repository/fork`. If you modify/extend the source code, you must also open-source it under AGPL-3.0-or-later, and indicate in the footer as "Powered by Hydro, Modified by xxx".

For commercial closed-source usage, please contact the Hydro team to purchase alternative licensing.
| Sidebar items missing after template override                | `manage_base.html` uses `ui.getNodes('ControlPanel')` dynamically | Use `ctx.injectUI('ControlPanel', ...)` instead of overriding the template |
