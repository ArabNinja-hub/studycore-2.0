# Homepage hero slideshow images

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

The hero gallery auto-rotates through these images with a smooth crossfade
(cross-dissolve) transition. If an image is missing or fails to load, the
gallery simply skips it — and if none are present it hides itself entirely
so the hero falls back to the clean text-only layout.
