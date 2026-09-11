# Patch Notes

Store-submission notes. Each entry must stay under 500 characters.

## 0.3.22

v0.3.22 - Jarvis stops cutting off its own answers

- A finished turn stays on screen until you leave it, instead of closing the mic after a couple of seconds.
- The ring pages the whole transcript, answer included.
- On a held answer: tap = talk again, double-tap = back to reading.

## 0.3.21

v0.3.21 - Jarvis talks, and remembers you

- Jarvis answers like a person when you are only talking. Every action still works.
- It remembers past conversations and summarises old ones past 100k words.
- The Jarvis screen scrolls with the ring, and answers no longer print twice.

## 0.3.20

v0.3.20 - Jarvis reads and watches agent runs

- Jarvis can read your agent sessions, newest first, including runs still going, and read any one in full.
- Runs it starts are watched. When one finishes it tells you, and you can scroll them at the bottom of the Jarvis screen.
- Fixed model tool-call tags leaking into replies.

## 0.3.19

v0.3.19 - Build a whole agent by voice

- Jarvis can now set every part of an agent: name, role, trigger prompt, tools and model, and edit them in place without rebuilding.
- Ask it what tools exist, then say things like "add web search" or "remove the weather tool".
- New: clone an agent, to copy one you like and tweak the copy.
- A misheard tool name no longer wipes an agent's tools; it is ignored and reported.

## 0.3.18

v0.3.18 - Agent list, Stop AI and mic fixes

- Agents now list newest first, and scrolling wraps around at the top and bottom.
- New agents turn on web search by default, and you can add web search or a REST tool straight from the agent editor.
- Fixed Stop AI: opening the menu while Jarvis was listening ended the conversation, so tapping Stop restarted it. It now stays put.
- Fixed a dictation error leaving the mic held, which blocked later voice triggers.

## 0.3.16

v0.3.16 - Sign in on the glasses app

- The glasses phone app no longer blocks you with a pairing code. It shows the same sign in as any browser, so it works on its own.
- Pairing is now optional and lives in Settings, for a device that cannot sign in.
- Devices you paired before keep working, and you can still list or revoke them.
- The glasses now ask you to sign in when nothing is connected.

## 0.3.15

v0.3.15 - Jarvis AI agent

- New Jarvis item at the top of the glasses menu. Ask in your own words and it does the job: to-dos, docs, notes.
- Its thinking shows on the lens while it works, then it speaks the result.
- Keep talking: speak again after each reply. Stop AI or double-tap ends it.
- Undo AI reverses its changes. Destructive actions ask first.
- The web app has a matching Jarvis panel, live timeline and Undo.
- Menu now runs Jarvis, Back, page actions, then Dictate last.

## 0.3.13

v0.3.13 - Dictation no longer stops itself

- Dictation stopped by itself after about 2 seconds. The mic frames were being misread as taps, which ended the session. Fixed.
- It now keeps listening until you tap to stop, and waits longer for a slow speech service instead of giving up.
- A dropped phrase no longer ends the session; you keep talking and it recovers.

## 0.3.12

v0.3.12 - Agents know the date

- Agents guessed the date, so "today", "this week" and "last week" returned the wrong period.
- Every run now gets the exact date and time from your device, and those phrases are resolved to real dates before any search runs.
- The resolved range is shown in the transcript.
- Applies to agent runs, chat and web search.

## 0.3.11

v0.3.11 - Dictation commits only when you stop

- Dictation no longer writes to the target field while you are still speaking, which was ending the session early.
- Your words now stream live on the glasses; the finished transcript is saved in one go when you stop (or when the session auto-ends).
- Fixed the dictation screen not appearing on the Agents tab.
- Applies everywhere: the Dictate menu item and every mic button in the app.

## 0.3.10

v0.3.10 - Back returns to the Agents menu

- Restored the Back item on the Agents menu so you can leave the tab without closing the app.
- The menu is now Dictate, Back, and Trigger (or Stop while a run is live).
- Tap the agent list to open the detail pane; double-tap returns to the list.

## 0.3.9

v0.3.9 - Leaner Agents menu, double-tap back

- The Agents menu now carries only Trigger (or Stop while a run is live), so the run control is never buried.
- Tap the agent list to open the detail pane; double-tap returns to the list instead of closing the app.
- Double-tap on the agent list itself still closes the app.

## 0.3.8

v0.3.8 - Full transcripts on the glasses

- The agent detail pane now pages through the whole transcript instead of cutting it off, so the glasses show what the web app shows.
- Swipe up/down to page; running past either end moves to the older or newer session.
- Tool calls are labelled clearly and long URLs no longer overflow the screen.
- Removed characters the glasses font cannot draw.

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
