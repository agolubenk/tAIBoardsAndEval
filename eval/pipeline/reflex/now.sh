#!/bin/sh
# П5: puts the local time into the model's context on every prompt and before
# writes, messages and owner-queue calls, so HH:MM never comes from memory
# (lessons «Time only from date», 23.10).
# Hook input arrives as JSON on stdin; only the event name is read from it.
event="$(cat | grep -o '"hook_event_name" *: *"[A-Za-z]*"' | head -1 | sed 's/.*"\([A-Za-z]*\)"$/\1/')"
now="$(date '+%H:%M %Z, %a %d.%m.%Y')"
case "$event" in
  PreToolUse | UserPromptSubmit)
    printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"Сейчас %s (date)."}}\n' "$event" "$now"
    ;;
  *)
    printf 'Сейчас %s (date).\n' "$now"
    ;;
esac
