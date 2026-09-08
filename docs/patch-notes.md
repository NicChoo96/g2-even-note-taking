# Patch Notes

Store-submission notes. Each entry must stay under 500 characters.

## 0.3.7

v0.3.7 - Sync & run fixes

- Fixed "relay refused the run" when triggering an agent from a browser (the auth header is now allowed on cross-origin requests).
- Agents saved in the browser now sync to your paired glasses.
- A stale local copy can no longer overwrite newer server data.
- Runs that hit the step limit now summarise instead of failing.

## 0.3.6

v0.3.6 - Settings & layout

- Your server environment keys are now detected and take over the Settings page, which locks them to avoid conflicts.
- Fixed the Agents page layout on web, mobile, and the glasses.
- Better input contrast across the agent editor and settings.
