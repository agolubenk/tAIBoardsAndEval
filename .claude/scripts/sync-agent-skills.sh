#!/usr/bin/env bash
# Mirror vendored skills from the canonical .claude/skills into the skill dirs other agent
# harnesses read (.agents/skills — Codex/Cursor/Gemini CLI/Copilot/OpenCode/Cline,
# .continue/skills, .windsurf/skills). Provenance, local patches and usage: .claude/skills/VENDORED.md
#
#   sync-agent-skills.sh                        canonical -> all mirrors
#   sync-agent-skills.sh --check                exit 1 on drift or an unpatched canonical skill
#   sync-agent-skills.sh --from-upstream DIR    refresh canonical from an upstream clone, re-apply
#                                               local patches, then mirror
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CANON="$ROOT/.claude/skills"
PROVENANCE="VENDORED.md"
MIRRORS=(".agents/skills" ".continue/skills" ".windsurf/skills")
SKILLS=(
  animate animate-expo animation-vocabulary apple-design ask-sonner emil-design-eng
  find-animation-opportunities improve-animations mobile-native pick-ui-library prototype
  review-animations write-swift
)

die() { echo "sync-agent-skills: $*" >&2; exit 2; }

in_skills() {
  local needle="$1" s
  for s in "${SKILLS[@]}"; do [[ "$s" == "$needle" ]] && return 0; done
  return 1
}

# Local patch 1 (VENDORED.md): drop `disable-model-invocation` from the frontmatter so every model
# and agent may invoke the skill. Only the leading `---` block is touched.
apply_local_patches() {
  local file="$1/SKILL.md" tmp
  tmp="$(mktemp)"
  awk '
    NR == 1 && $0 == "---" { in_fm = 1; print; next }
    in_fm && $0 == "---"   { in_fm = 0; print; next }
    in_fm && $0 ~ /^disable-model-invocation:/ { next }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

is_patched() {
  ! awk 'NR == 1 && $0 == "---" { in_fm = 1; next } in_fm && $0 == "---" { exit } in_fm && /^disable-model-invocation:/ { found = 1 } END { exit !found }' "$1/SKILL.md"
}

from_upstream() {
  local upstream="$1/skills" s name
  [[ -d "$upstream" ]] || die "no skills/ directory in $1"
  for s in "${SKILLS[@]}"; do
    [[ -f "$upstream/$s/SKILL.md" ]] || die "upstream has no $s/SKILL.md"
  done
  for s in "${SKILLS[@]}"; do
    rm -rf "${CANON:?}/$s"
    cp -R "$upstream/$s" "$CANON/$s"
    apply_local_patches "$CANON/$s"
  done
  for s in "$upstream"/*/; do
    name="$(basename "$s")"
    in_skills "$name" || echo "note: upstream has a skill not vendored here: $name (add it to SKILLS to vendor it)"
  done
  echo "canonical refreshed from $1 — update the commit in $CANON/$PROVENANCE"
}

mirror() {
  local m s
  for s in "${SKILLS[@]}"; do
    [[ -f "$CANON/$s/SKILL.md" ]] || die "canonical skill missing: $CANON/$s/SKILL.md"
  done
  for m in "${MIRRORS[@]}"; do
    mkdir -p "$ROOT/$m"
    for s in "${SKILLS[@]}"; do
      rm -rf "${ROOT:?}/$m/$s"
      cp -R "$CANON/$s" "$ROOT/$m/$s"
    done
    cp "$CANON/$PROVENANCE" "$ROOT/$m/$PROVENANCE"
  done
  echo "mirrored ${#SKILLS[@]} skills into: ${MIRRORS[*]}"
}

check() {
  local drift=0 m s
  for s in "${SKILLS[@]}"; do
    if ! is_patched "$CANON/$s"; then
      echo "unpatched canonical skill: $s (disable-model-invocation present)"
      drift=1
    fi
  done
  for m in "${MIRRORS[@]}"; do
    for s in "${SKILLS[@]}"; do
      if ! diff -rq "$CANON/$s" "$ROOT/$m/$s" > /dev/null 2>&1; then
        echo "drift: $m/$s"
        drift=1
      fi
    done
    if ! cmp -s "$CANON/$PROVENANCE" "$ROOT/$m/$PROVENANCE"; then
      echo "drift: $m/$PROVENANCE"
      drift=1
    fi
  done
  if [[ $drift -eq 0 ]]; then
    echo "ok: ${#SKILLS[@]} skills identical across .claude/skills and ${MIRRORS[*]}"
  else
    echo "run .claude/scripts/sync-agent-skills.sh to re-mirror" >&2
  fi
  return $drift
}

case "${1:-}" in
  "") mirror ;;
  --check) check ;;
  --from-upstream)
    [[ -n "${2:-}" ]] || die "--from-upstream needs a path to an upstream clone"
    from_upstream "$2"
    mirror
    ;;
  -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" ;;
  *) die "unknown argument: $1 (see --help)" ;;
esac
