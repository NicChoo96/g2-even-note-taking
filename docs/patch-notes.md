# Patch Notes

Store-submission notes. Each entry must stay under 500 characters.

## 0.3.38

v0.3.38 - Jarvis can use your lists, and they stop emptying themselves

- Jarvis can now read and edit your to-do list, documents and notes, so
 an agent can add a task or write a note. Each store is off until you
 enable it for that agent.
- Agents can also call a REST endpoint you name.
- Fixed: your list could empty itself with nobody deleting anything. A
 device that reconnected sent an older copy, and the app adopted it. An
 older copy can no longer overwrite a newer one.

## 0.3.37

v0.3.37 - Jarvis actions come from the server

- The actions Jarvis can take on your stored pages are now read from
 the document server itself. The list used to be a copy kept by hand,
 and a copy can fall behind the server with nothing to notice.
- If Jarvis asks for an action it was not offered, it is told which
 ones it can use and corrects itself in one step.
- The relay checks its list against the server at startup and reports
 anything missing.

## 0.3.36

v0.3.36 - embedded video plays in a stored page

- Videos embedded in a stored page now play on the page itself,
 instead of showing a blocked box.
- Stored pages are served from a second address of their own, so a
 video player inside one is no longer shut out.
- One setup step: point the server at that second address. Until it
 is set, pages behave exactly as before.

## 0.3.35

v0.3.35 - video plays in stored pages

- A stored page with embedded videos now plays them in the web Files tab,
 on the page itself instead of a blocked box.
- The glasses sign-in screen now shows your pairing code, so you can read
 it off the lens.
- Buttons in the Files list were black on black; the text is readable now.

## 0.3.34

v0.3.34 - deletes you can take back

- Deleting a stored page no longer hides it for good. The web Files tab now has
 a Deleted list where a removed page can be restored, or purged for real.
- A delete tells you what it did and offers Undo on the spot.
- Reading a page that was deleted says so, instead of blaming the network.

## 0.3.33

v0.3.33 - agent-written pages, stored and read back

- New Files page on the glasses, after Notes. It lists HTML pages that Jarvis or an agent has published to your document store.
- Scroll the list on the glasses; open the Files tab on the web to read a page in a locked-down frame.
- Only the reference is saved on the device, never the page itself. Publishing and deleting ask first.

## 0.3.32

v0.3.32 - each agent keeps its own run

- Switching agents in the list no longer showed the other agent's live run in the detail pane.
- Two agents can run at the same time now; scroll the list to watch whichever one you want.
- Stop only stops the agent you are looking at.
- A run left going in the background is marked with a dot in the list.

## 0.3.31

v0.3.31 - history stays put, and Agents leads the menu

- Finishing a run no longer clears the session list you were reading. The 5-session limit is per agent now, not one pool for the whole app.
- History merges rather than overwriting, so a backgrounded phone cannot delete runs another device recorded.
- Clearing an agent's history still removes it everywhere.
- The page switcher now reads Agents, To-Do, Docs, Notes. The app still opens on To-Do.

## 0.3.30

v0.3.30 - save any setting, and let it stick

- Every field on the Settings page is editable now and saves on its own. Changing one no longer rewrites another.
- A value you save wins over the server environment. The environment only fills in what you have not saved. Use "remove saved value" to hand a field back.
- Switching your web search provider no longer touches your LLM model.
- Each field says where its value comes from.

## 0.3.29

v0.3.29 - swappable web search, and a spoken line keeps your task

- Web search runs on Tavily or Brave Search. Pick one in Settings, or let it auto-detect whichever key is set.
- The search tool is now "Web search" everywhere.
- Speaking to an agent adds a one-off instruction instead of overwriting the saved task.
- Destructive actions need an explicit approval in the same run.
- The menu collapses to the essentials during a Jarvis conversation.

## 0.3.28

v0.3.28 - a past session reads back whole, not truncated

- Reading back an earlier session kept reporting the history as truncated, because the record was cut short as it was written.
- Sessions now save exactly what the model saw, so a finished run reads back in full.
- The decide tool can no longer fall off a crowded page's action menu.

## 0.3.27

v0.3.27 - Jarvis can decide, not just describe

- New: ask a typed question about a piece of text and get a straight answer back - yes or no with a probability, one choice out of options you set, or a step on an ordered scale.
- Jarvis uses it to route, rank and check its own work instead of guessing at prose.
- Add it to an agent from the Agents panel. It runs on the OpenRouter key you already saved.

## 0.3.26

v0.3.26 - Jarvis can write to your documents from any page

- Asked to add to a document while on the To-Do page, Jarvis used to reply that it had no access. It now routes to Docs and does it.
- Jarvis's instructions list every action of every page, so nothing looks off-limits.
- Speak and route can no longer be dropped from a crowded page's action menu.

## 0.3.25

v0.3.25 - Jarvis answers in full, however long that takes

- The reply is no longer trimmed to fit an estimated chat length; the app asked for two or three sentences and then cut whatever came back.
- The prompt and the say__reply tool now ask for the whole answer, and only a runaway reply is ever stopped.
- A long answer is paged by the ring, so every sentence is reachable.

## 0.3.24

v0.3.24 - Jarvis stops vanishing mid-read

- Fixed an answer disappearing while you were reading it, which left the menu on "Stop AI" over the plain page underneath.
- A run owned by the phone can no longer overwrite what the glasses are showing, and a stale frame from an earlier connection is ignored.
- The menu offers "Stop AI" only while a reply or the mic is really on screen, so the way out always works.

## 0.3.23

v0.3.23 - Jarvis reads top-down, and never cuts you off

- Newest reply is at the top; older thinking is grouped under labelled sections so you can see where one ends and the next begins.
- Long answers are no longer clipped mid-sentence.
- Talking and reading are one screen: your words stream at the top while the ring still pages the reply underneath.

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
