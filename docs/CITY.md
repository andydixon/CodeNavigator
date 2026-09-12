# City guide

Switch to **City** in the toolbar. The city is laid out from the repository's folder tree at human
scale, so a large repository is a large city.

## Reading the city

| You see | It means |
|---|---|
| A **district** (big block, name floating above its tallest tower) | A top-level folder |
| A **block** inside it, separated by streets | A nested folder; deeper folders have narrower streets |
| A **building** | A file |
| Building **footprint** | Lines of code |
| Building **height** | Complexity (branching) |
| **Lit windows** | Definitions: more functions and classes, more lights on |
| Building **colour** | Semantic layer (application, tests, vendor, …), switchable palette |
| Name on the **roof** and **wall** | The file name |
| **Green street sign** sticking out at a corner | The folder that block belongs to; each corner of an intersection names its own folder |
| **Smoke** | The file has open medium/low security alerts |
| **Fire and smoke** | The file has an open critical/high security alert |
| **Yellow tape** rising across the walls | Dependabot alert (on the manifest file) |
| **Red tape** falling across the walls | Code scanning alert |
| **Light beam** into the sky | A search result |
| **Lit doorway** | The building's door: facing the street, or a back door onto an alley for files in the middle of a folder |
| **Streetlights** with pools of light | The edges of each folder: lights stand on its boundary, at every corner and every 20 m or so |
| **Bins, benches, trees, hydrants, post boxes** | Street furniture on the folder's pavement. Purely for atmosphere |
| **Cyan chevrons** on the road | Route to a file the selected file imports (**amber** if the import was inferred) |
| **Pulsing magenta dashes** on the road | Route from a file that imports the selected file |
| **Arcs** in the sky | The same import relationships, as the crow flies |
| **Green figures** | Residents. Click one (or aim the crosshair and press `E`) and they stop, glow pink with their name overhead, and the sidebar shows their resident ID card: name, sex, age, occupation, employer, eye and hair colour, blood type. The same resident is always the same person. |
| **Wall with posters** | The city limits, with a few facts about the codebase pasted on |

## Getting around

**Helicopter (`1`)**: drag to orbit, Shift+drag (or right-drag) to pan, scroll to zoom.
Double-click a building to fly to it, or double-click a street to drop down and walk.

**Walk (`2`)**: click the map to capture the mouse and look around, `WASD` to move, `Shift` to run,
`Esc` to release the mouse. The crosshair names the building ahead. Press `E` (or click) to open
it in the sidebar. Walk right up to a building and its source code appears on the wall. You can't
walk through buildings or out past the city wall.

**Fly (`3`)**: like walking, but `Space` and `C` climb and descend, and moving follows where you
look.

**Touch**: left thumb is a joystick, right thumb looks around, pinch zooms (or climbs when flying).

**Minimap**: click it to jump there. It shows your heading, the city wall, security alerts and
the selected file's routes.

## Following dependencies

Select a file (click it, search for it, or pick it from the sidebar). Routes appear on the streets
to everything it imports and from everything that imports it. Every route leaves through the
building's door, follows the alley to the street if it's a back door, and goes in through the other
building's door. Alley stretches are drawn thinner. With a file selected, switching to
**Walk** puts you at its door facing along the first route: follow the arrows.

## Tour and links

- **Tour (`T`)**: flies over the six largest districts with captions, and stops as soon as you
  touch anything.
- **Copy link**: copies a URL with the repository, view, camera position and selected file.
  Links work for GitHub repositories only.

Opening a shared link:

- **Repository already open in this tab:** you fly straight to the spot, and the file is selected.
- **Repository not loaded here:** a card says it's being pulled from GitHub and indexed. Once it's
  built, you're flown to the saved camera position and the file is selected.
- **Private repository you can't access** (not signed in on this device, or your GitHub access has
  expired): you get a warning with a **Sign in with GitHub** button. After signing in, the link
  carries on by itself to the shared spot.
- **Private repository the GitHub App can't see:** the warning offers **Grant repository access**
  instead.

## Settings

The gear opens settings: landscape palette, source text on tiles, **city residents** (they keep
the city animating, so switch them off on slow machines) and a frame-rate monitor. The sidebar
folds away with the tab on its left edge, or `[`.
