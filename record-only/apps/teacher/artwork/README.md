# Teacher application icon

`icon.svg` is the editable master. Run `python render-icon.py` with CairoSVG 2.9 and Pillow 12.1 to regenerate the checked-in Windows ICO and the runtime PNG. Normal app builds use the generated files directly and do not need Python.

- The ID card uses Google's [Material Symbols Rounded `id_card`](https://fonts.google.com/icons?selected=Material+Symbols+Rounded:id_card:FILL@0;wght@400;GRAD@0;opsz@48), under [Apache License 2.0](material-symbols-LICENSE.txt). The path is unchanged; its color, scale and projection are adapted for this icon.
- The motif on the reader is a vector trace of the central artwork in the [school's official header logo](https://web-hscyez.pte.sh.cn/assets-cyez/img/logo.png). The school's outer rings, wordmark and date are excluded. The school emblem is not part of Material Symbols or its Apache license.
