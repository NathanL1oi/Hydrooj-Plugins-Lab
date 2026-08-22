# user-background

Hydro addon for site-managed page backgrounds.

## Features

- Adds a user dropdown entry named `Background`.
- Adds a control panel entry named `Background Library`.
- Only users with `PRIV_EDIT_SYSTEM` can upload and delete background images.
- Ships a built-in `default` background image that cannot be deleted.
- Users with no saved preference get the built-in `default` image enabled at 30% opacity.
- Each uploaded image is stored with an admin-provided display name.
- Logged-in users can choose one image from the shared library and set opacity.
- Applies the background globally through a fixed background layer.
- Controls only the background layer opacity, so page text and controls remain readable.
- Serves selected images through stable global URLs with long-lived browser cache headers.

## Storage

- Image metadata: MongoDB collection `user.background.image`.
- User preferences: MongoDB collection `user.background`.
- Image files: Hydro `StorageModel` under `user-background/library/<imageId>/`.
- Built-in default image: `assets/default-background.png`.

## Routes

- `GET /manage/user-background`: admin background library.
- `POST /manage/user-background` with `operation=upload`: upload a named image.
- `POST /manage/user-background` with `operation=delete`: delete a library image.
- `GET /home/background`: user settings page.
- `POST /home/background`: save enabled state, opacity, and selected image.
- `GET /home/background/config`: frontend config endpoint for the current user.
- `GET /home/background/file/:imageId/:filename`: shared library image file.

## Limits

- Max image size: 8 MB.
- Allowed extensions: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`.
- SVG is intentionally not supported.
- The image name `default` is reserved for the built-in background.
