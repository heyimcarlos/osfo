#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 || -z "$2" ]]; then
  echo "usage: capture-three-tab-evidence.sh <packet-index> <new-output-directory>" >&2
  exit 2
fi
if [[ -z "${OSFO_TEST_DATABASE_URL:-}" ]]; then
  echo "OSFO_TEST_DATABASE_URL is required" >&2
  exit 2
fi

repository_root="$(git rev-parse --show-toplevel)"
index_path="$(realpath "$1")"
output_directory="$(realpath -m "$2")"
raw_directory="$(mktemp -d /tmp/osfo-three-tab-evidence.XXXXXX)"
ffmpeg_diagnostics="$raw_directory/ffmpeg.log"

cleanup() {
  if [[ "$raw_directory" == /tmp/osfo-three-tab-evidence.* && -d "$raw_directory" ]]; then
    find "$raw_directory" -depth -delete
  fi
}
trap cleanup EXIT

cd "$repository_root"
bun observability/demo-packet-verifier.ts "$index_path"
command -v ffmpeg > /dev/null
command -v ffprobe > /dev/null
if [[ -e "$output_directory" ]] && find "$output_directory" -mindepth 1 -print -quit | rg -q .; then
  echo "refusing to overwrite non-empty output directory: $output_directory" >&2
  exit 1
fi

OSFO_THREE_TAB_EVIDENCE_DIR="$raw_directory" \
  bunx vitest run --no-file-parallelism \
  apps/web/test/three-tab-reference-journey.postgres.test.ts

for tab in A B C; do
  frame_count="$(find "$raw_directory/frames/$tab" -maxdepth 1 -type f -name '*.png' | wc -l)"
  if [[ "$frame_count" -lt 4 ]]; then
    echo "tab $tab produced fewer than four frames" >&2
    exit 1
  fi
  invalid_frames="$(
    find "$raw_directory/frames/$tab" -maxdepth 1 -type f -name '*.png' -print0 \
      | xargs -0 file \
      | rg -v 'PNG image data, 640 x 960,' \
      || true
  )"
  if [[ -n "$invalid_frames" ]]; then
    echo "tab $tab contains a frame outside the required 640x960 viewport" >&2
    exit 1
  fi
done

frame_count_a="$(find "$raw_directory/frames/A" -maxdepth 1 -type f -name '*.png' | wc -l)"
frame_count_b="$(find "$raw_directory/frames/B" -maxdepth 1 -type f -name '*.png' | wc -l)"
frame_count_c="$(find "$raw_directory/frames/C" -maxdepth 1 -type f -name '*.png' | wc -l)"
if [[ "$frame_count_a" -ne "$frame_count_b" || "$frame_count_a" -ne "$frame_count_c" ]]; then
  echo "three-tab frame counts differ" >&2
  exit 1
fi

mkdir -p -- "$output_directory"
ffmpeg -hide_banner -loglevel error -y \
  -framerate 4 -i "$raw_directory/frames/A/%06d.png" \
  -framerate 4 -i "$raw_directory/frames/B/%06d.png" \
  -framerate 4 -i "$raw_directory/frames/C/%06d.png" \
  -filter_complex '[0:v][1:v][2:v]hstack=inputs=3[combined]' \
  -map '[combined]' \
  -r 4 \
  -c:v libx264 \
  -pix_fmt yuv420p \
  -movflags +faststart \
  -metadata title='OpenPoke authenticated independent three-tab resume, local PostgreSQL journey' \
  -metadata comment='Sender-close-mid-response is not exercised.' \
  "$output_directory/authenticated-three-tab-resume.mp4" \
  2> "$ffmpeg_diagnostics"
if [[ -s "$ffmpeg_diagnostics" ]]; then
  cat "$ffmpeg_diagnostics" >&2
  exit 1
fi

cp -- "$raw_directory/journey.json" "$output_directory/journey.json"
ffprobe -v error \
  -show_entries 'stream=codec_name,width,height,avg_frame_rate,nb_frames:format=duration,format_name,tags' \
  -of json \
  "$output_directory/authenticated-three-tab-resume.mp4" \
  > "$output_directory/ffprobe.json"

jq -e '
  .streams as $streams |
  ($streams | length) == 1 and
  $streams[0].codec_name == "h264" and
  $streams[0].width == 1920 and
  $streams[0].height == 960 and
  $streams[0].avg_frame_rate == "4/1" and
  ($streams[0].nb_frames | tonumber) >= 4
' "$output_directory/ffprobe.json" > /dev/null
jq -e '
  .schemaVersion == 1 and
  .framesPerSecond == 4 and
  .viewport == {"width":640,"height":960} and
  .proofScope == "authenticated independent observer-tab disconnect and cursor resume; sender-close-mid-response is not exercised" and
  (.events | length == 11)
' "$output_directory/journey.json" > /dev/null

if rg -a -n \
  'oz-three-tab-reference-session|6ef239bd-3f04-4c77-8976-1171e75ea0ab|/home/|heyimcarlos' \
  "$output_directory"; then
  echo "three-tab evidence contains a token, private identifier, or private path" >&2
  exit 1
fi

(
  cd "$output_directory"
  sha256sum \
    ./authenticated-three-tab-resume.mp4 \
    ./ffprobe.json \
    ./journey.json \
    > THREE-TAB-SHA256SUMS
  sha256sum -c THREE-TAB-SHA256SUMS
)

echo "PASS: sealed authenticated three-tab evidence at $output_directory"
