#!/usr/bin/env bash
# Builds a cinematic 16:9 teaser MP4 for the Long Service Award Ceremony
# at The Westin Turtle Bay Resort & Spa Mauritius.
#
# Pure-ffmpeg pipeline: animated gradients (sunrise, gold radial, sunset),
# slow time-driven push-in, low-res shimmer particles upscaled for soft
# light flares, vignette, elegant serif drawtext with timed alpha fades,
# and a layered piano-chord + ocean ambience audio bed.
# Output: H.264 (yuv420p) + AAC, faststart — playable on Android.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/public"
WORK_DIR="$ROOT/.teaser-build"
OUT="$OUT_DIR/teaser.mp4"

mkdir -p "$OUT_DIR" "$WORK_DIR"
rm -f "$WORK_DIR"/*.mp4 "$WORK_DIR"/*.m4a

W=1920
H=1080
FPS=30
FONT_TITLE="/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf"
FONT_SUB="/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"

GOLD="0xD4AF37"
SOFT_WHITE="0xF7F1E6"
DEEP_GOLD="0xB8860B"

log() { printf "\033[0;36m[teaser]\033[0m %s\n" "$*"; }

# render_scene <out.mp4> <duration> <gradient-spec> <main-text> <sub-text> <text-color>
render_scene() {
  local out="$1" dur="$2" grad="$3" main="$4" sub="$5" color="$6"

  local t_in=1.2
  local t_full=2.0
  local t_out_start t_out_end t_fadeout
  t_out_start=$(awk -v d="$dur" 'BEGIN{printf "%.2f", d-1.6}')
  t_out_end=$(awk -v d="$dur" 'BEGIN{printf "%.2f", d-0.6}')
  t_fadeout=$(awk -v d="$dur" 'BEGIN{printf "%.2f", d-0.6}')

  local main_alpha="if(lt(t,$t_in),0,if(lt(t,$t_full),(t-$t_in)/($t_full-$t_in),if(lt(t,$t_out_start),1,if(lt(t,$t_out_end),1-(t-$t_out_start)/($t_out_end-$t_out_start),0))))"
  local sub_t_in sub_t_full
  sub_t_in=$(awk -v a="$t_in" 'BEGIN{printf "%.2f", a+0.6}')
  sub_t_full=$(awk -v a="$t_full" 'BEGIN{printf "%.2f", a+0.6}')
  local sub_alpha="if(lt(t,$sub_t_in),0,if(lt(t,$sub_t_full),(t-$sub_t_in)/($sub_t_full-$sub_t_in),if(lt(t,$t_out_start),1,if(lt(t,$t_out_end),1-(t-$t_out_start)/($t_out_end-$t_out_start),0))))"

  # Escape colons + single quotes in drawtext strings
  local main_esc sub_esc
  main_esc=$(printf '%s' "$main" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g; s/:/\\\\:/g")
  sub_esc=$(printf '%s' "$sub"  | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g; s/:/\\\\:/g")

  local sub_filter=""
  if [[ -n "$sub" ]]; then
    sub_filter=",drawtext=fontfile=${FONT_SUB}:text='${sub_esc}':fontcolor=${color}:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2+95:alpha='${sub_alpha}':shadowcolor=0x00000080:shadowx=0:shadowy=2"
  fi

  log "  scene → $(basename "$out") (${dur}s)  «${main}»"

  # Build pipeline:
  #   [grad]  rich animated gradient (full-res)
  #     → time-driven crop push-in → scale → eq → vignette
  #   [shim]  low-res procedural shimmer (192x108) → scale up → blur → alpha
  #   overlay shim onto bg, add drawtext, fade in/out
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "gradients=size=${W}x${H}:rate=${FPS}:duration=${dur}:${grad}" \
    -f lavfi -i "color=c=black:size=240x135:rate=${FPS}:duration=${dur}" \
    -filter_complex "
      [0:v]format=rgb24,
        scale=eval=frame:w='ceil(${W}*(1+0.025*t)/2)*2':h='ceil(${H}*(1+0.025*t)/2)*2',
        crop=${W}:${H},
        eq=brightness=0.02:saturation=1.10:contrast=1.05,
        vignette=mode=forward
        [bg];

      [1:v]geq=
        r='clip(120 + 80*sin(2*PI*(X+T*30)/40) + 60*sin(2*PI*(Y-T*22)/55) + 60*random(1), 0, 255)':
        g='clip(95 + 60*sin(2*PI*(X+T*30)/40) + 45*sin(2*PI*(Y-T*22)/55) + 45*random(1), 0, 220)':
        b='clip(35 + 25*sin(2*PI*(X+T*30)/40) + 18*sin(2*PI*(Y-T*22)/55) + 18*random(1), 0, 140)',
        scale=${W}:${H}:flags=bicubic,
        gblur=sigma=24,
        format=rgba,
        colorchannelmixer=aa=0.22
        [shim];

      [bg][shim]overlay=0:0:format=auto[lit];

      [lit]drawtext=fontfile=${FONT_TITLE}:text='${main_esc}':fontcolor=${color}:fontsize=92:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${main_alpha}':shadowcolor=0x00000099:shadowx=0:shadowy=3${sub_filter},
        fade=t=in:st=0:d=0.6:color=black,
        fade=t=out:st=${t_fadeout}:d=0.6:color=black,
        format=yuv420p
    " \
    -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart -an \
    "$out"
}

# ---------------------------------------------------------------------------
# Scene plan (≈ 38s after crossfades)
# ---------------------------------------------------------------------------

log "Rendering scene 1/6 — sunrise over the ocean"
render_scene "$WORK_DIR/s1.mp4" 7 \
  "c0=0x0E2A3A:c1=0x2C5F70:c2=0xE9C879:c3=0xFCEBC2:nb_colors=4:type=linear:x0=960:y0=1080:x1=960:y1=0:speed=0.001" \
  "Honoring Dedication" \
  "" \
  "$SOFT_WHITE"

log "Rendering scene 2/6 — aerial gold over tropical greens"
render_scene "$WORK_DIR/s2.mp4" 7 \
  "c0=0xF4D26A:c1=0xC79A2B:c2=0x4F7C3A:c3=0x1F3D24:nb_colors=4:type=radial:x0=960:y0=480:x1=1700:y1=900:speed=0.0015" \
  "Celebrating Commitment" \
  "" \
  "$SOFT_WHITE"

log "Rendering scene 3/6 — white florals & gold accents"
render_scene "$WORK_DIR/s3.mp4" 7 \
  "c0=0xFFFFFF:c1=0xF7E9C8:c2=0xE6C66E:c3=0xC79A2B:nb_colors=4:type=radial:x0=720:y0=540:x1=1500:y1=800:speed=0.0012" \
  "Years of Excellence" \
  "" \
  "$DEEP_GOLD"

log "Rendering scene 4/6 — candle-light ceremony warmth"
render_scene "$WORK_DIR/s4.mp4" 7 \
  "c0=0xFFE9A8:c1=0xE0A53A:c2=0x7A3F12:c3=0x1A0A04:nb_colors=4:type=circular:x0=960:y0=540:x1=1500:y1=540:speed=0.002" \
  "Long Service Award" \
  "Ceremony" \
  "$SOFT_WHITE"

log "Rendering scene 5/6 — venue reveal"
render_scene "$WORK_DIR/s5.mp4" 7 \
  "c0=0x2C5F45:c1=0x66996E:c2=0xE6C66E:c3=0xF7E9C8:nb_colors=4:type=linear:x0=0:y0=1080:x1=1920:y1=0:speed=0.0012" \
  "The Westin Turtle Bay" \
  "Resort & Spa Mauritius" \
  "$SOFT_WHITE"

log "Rendering scene 6/6 — sunset finale"
render_scene "$WORK_DIR/s6.mp4" 8 \
  "c0=0x1A0A20:c1=0x6B2B3A:c2=0xD9762E:c3=0xF4D26A:nb_colors=4:type=linear:x0=960:y0=1080:x1=960:y1=0:speed=0.0008" \
  "An Evening of Recognition" \
  "& Gratitude" \
  "$SOFT_WHITE"

# ---------------------------------------------------------------------------
# Crossfade scenes together (1.0s xfade between each pair)
# ---------------------------------------------------------------------------
log "Crossfading 6 scenes into the master visual track"

ffmpeg -hide_banner -loglevel error -y \
  -i "$WORK_DIR/s1.mp4" \
  -i "$WORK_DIR/s2.mp4" \
  -i "$WORK_DIR/s3.mp4" \
  -i "$WORK_DIR/s4.mp4" \
  -i "$WORK_DIR/s5.mp4" \
  -i "$WORK_DIR/s6.mp4" \
  -filter_complex "
    [0:v][1:v]xfade=transition=fade:duration=1:offset=6[v01];
    [v01][2:v]xfade=transition=fade:duration=1:offset=12[v02];
    [v02][3:v]xfade=transition=fade:duration=1:offset=18[v03];
    [v03][4:v]xfade=transition=fade:duration=1:offset=24[v04];
    [v04][5:v]xfade=transition=fade:duration=1:offset=30,
      fade=t=out:st=36.5:d=1.5:color=black,
      format=yuv420p[vout]
  " \
  -map "[vout]" \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart -an \
  "$WORK_DIR/visual.mp4"

VIDEO_DURATION=38

# ---------------------------------------------------------------------------
# Audio bed: layered piano chord progression + ocean ambience
# ---------------------------------------------------------------------------
log "Composing audio bed (piano chords + ocean ambience)"

# 6 bars of ~6.33s each across 38s.
# Cmaj → Am → Fmaj → Cmaj/G → Fmaj → Cmaj
# Commas must be escaped (\,) so ffmpeg's filter parser doesn't split them.
F1='if(lt(t\,6.33)\,261.63\,if(lt(t\,12.67)\,220.00\,if(lt(t\,19)\,174.61\,if(lt(t\,25.33)\,196.00\,if(lt(t\,31.67)\,174.61\,261.63)))))'
F2='if(lt(t\,6.33)\,329.63\,if(lt(t\,12.67)\,261.63\,if(lt(t\,19)\,220.00\,if(lt(t\,25.33)\,261.63\,if(lt(t\,31.67)\,220.00\,329.63)))))'
F3='if(lt(t\,6.33)\,392.00\,if(lt(t\,12.67)\,329.63\,if(lt(t\,19)\,261.63\,if(lt(t\,25.33)\,329.63\,if(lt(t\,31.67)\,261.63\,392.00)))))'
F4='if(lt(t\,6.33)\,523.25\,if(lt(t\,12.67)\,440.00\,if(lt(t\,19)\,349.23\,if(lt(t\,25.33)\,392.00\,if(lt(t\,31.67)\,349.23\,523.25)))))'

# Soft attack + slow decay envelope per bar.
ENV='(1 - exp(-3*mod(t\,6.333))) * exp(-0.18*mod(t\,6.333))'
# Slow swell — emotional build to peak around 28s.
SWELL='0.55 + 0.45*sin(2*PI*(t-9)/56)'

PIANO="(sin(2*PI*(${F1})*t)*0.30 + sin(2*PI*(${F2})*t)*0.24 + sin(2*PI*(${F3})*t)*0.20 + sin(2*PI*(${F4})*t)*0.16) * (${ENV}) * (${SWELL})"

# Ocean ambience: noisy waves with slow amplitude modulation.
OCEAN="((random(0)*2-1)*0.35) * (0.55 + 0.45*sin(2*PI*0.18*t))"

AUDIO_FADEOUT=$(awk -v d="$VIDEO_DURATION" 'BEGIN{printf "%.2f", d-2.5}')

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc=exprs=${PIANO}:s=44100:d=${VIDEO_DURATION}" \
  -f lavfi -i "aevalsrc=exprs=${OCEAN}:s=44100:d=${VIDEO_DURATION}" \
  -filter_complex "
    [0:a]lowpass=f=3500,highpass=f=120,volume=0.55[piano];
    [1:a]lowpass=f=400,highpass=f=60,volume=0.18[waves];
    [piano][waves]amix=inputs=2:duration=longest:normalize=0,
      acompressor=threshold=-18dB:ratio=3:attack=20:release=400,
      afade=t=in:st=0:d=2.0,
      afade=t=out:st=${AUDIO_FADEOUT}:d=2.5,
      aformat=channel_layouts=stereo:sample_rates=44100
  " \
  -c:a aac -b:a 192k \
  "$WORK_DIR/audio.m4a"

# ---------------------------------------------------------------------------
# Mux video + audio into the final Android-compatible MP4
# ---------------------------------------------------------------------------
log "Muxing final MP4 → $OUT"

ffmpeg -hide_banner -loglevel error -y \
  -i "$WORK_DIR/visual.mp4" \
  -i "$WORK_DIR/audio.m4a" \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy \
  -c:a copy \
  -shortest \
  -movflags +faststart \
  "$OUT"

log "Done."
ffprobe -hide_banner -loglevel error -show_entries \
  format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate,channels,sample_rate \
  -of default=noprint_wrappers=0 "$OUT"

ls -lh "$OUT"
