# Homepage hero background images

Drop your 6 tutorial-class photos here, named exactly:

```
slide-1.jpg
slide-2.jpg
slide-3.jpg
slide-4.jpg
slide-5.jpg
slide-6.jpg
```

Any `.jpg` / `.jpeg` / `.png` / `.webp` works — just keep the filenames
matching the `<img src>` references in `public/index.html` (or update the
`src` attributes there to match whatever filenames you use).

The photos are used as a full-bleed background behind the homepage hero
copy. They rotate one by one with a smooth crossfade, and each photo
slowly pans (translates) across the hero while it is on screen,
alternating direction every slide. A dark scrim keeps the heading and
text readable on top of the photos. If an image is missing or fails to
load, the rotation simply skips it — and if none are present the
background hides itself entirely so the hero falls back to the clean
text-only gradient layout.
