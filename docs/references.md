# References

Material used while working out how the DSC-MD1 talks to a computer. Sony's software and
manual are not included in this repository; links are given where they are publicly archived.

## Sony software and documentation

* **Sony Digital Still Camera Utility 1.5** (the "DSC Utility" CD, `SONYDSCUv15.iso`), which
  includes the Album software and "Sony DSC-F1 TWAIN 1.5": archived at
  <https://archive.org/details/sonydscuv15>. Disassembling its `ALBUM.EXE` revealed the
  directory-listing, speed and write commands (see reverse-engineering-notes.md).
* **DSC-MD1 instruction manual** (Japanese). The cheat sheets in `cheatsheet/` translate it.
  The relabelled diagrams made from its illustrations are not in this repository.
* The original PC kit was the **DSKIT-PC4** (software + serial cable), now very hard to find.

## Community

* Post by **@defor** on X (2025-05-08) noting that the DSC-MD1 is fully supported by DSC Utility 1.5a, with
  the archive link: <https://x.com/defor/status/1920659851731980567>.
* **MiniDisc Community Page** (minidisc.org): Sony DSC-MD1 product page, with specs and
  history.
* PC Watch (Impress), 1997-10-08 product announcement:
  <http://www.watch.impress.co.jp/pc/docs/article/971008/seihin.htm>.

## Open-source code for the related DSC-F1

* libgphoto2 `camlibs/sonydscf1`: <https://github.com/gphoto/libgphoto2>
* chotplay 0.06 (DSC-F1 download tool for Unix), the origin of the framing and command
  numbers.

## Hardware that worked

* A USB-to-RS232 adapter with an FTDI FT232R chip and a male DB9:
  [OIKWAN USB to RS232](https://www.amazon.com/dp/B0759HSLP1).
* A "DB9 9-pin female to 3.5 mm male plug RS232 cable":
  [Qaoquda DB9 to 3.5 mm](https://www.amazon.com/dp/B06WLP4LTP). Works as bought; no null modem.
