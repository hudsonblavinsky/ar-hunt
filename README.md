# ONE SHOT — AR hunt (v1, fake mode)

Phone-browser AR hunting game. Cartoon animals hide behind the **real** trees, bushes, rocks, benches and fences in your camera view. One bullet per animal.

- **Scene understanding:** Roboflow Workflow `ar-hunt-scene-scan` (SAM 3, text prompts: tree trunk, bush, rock, bench, fence, log, tree stump) in workspace `hudsons-workspace-7m230`.
- **`/api/scan`** (Vercel function): takes a ~640px JPEG, calls the Workflow, returns simplified normalized outlines. The Roboflow key lives only in the `ROBOFLOW_API_KEY` env var.
- **Client (`public/`)**: plain HTML/JS, no build step. Scan → lock scene → gyro pans overlays → auto rescan every ~12 s or after ~14° drift (only while no animal is up). Shots are judged on-device: crosshair vs animal hitbox, minus any landmark in front of it (closer = lower base on screen). Kill cam = canvas snapshot of your best shot.

## Controls
- Phone + camera: crosshair is screen center, tap anywhere to fire.
- Desktop / photo: crosshair follows the mouse, click or Space to fire. `M` toggles the cover masks.

## Env vars
`ROBOFLOW_API_KEY` (sensitive), `ROBOFLOW_WORKSPACE`, `ROBOFLOW_WORKFLOW`.
