import fs from "fs";
import path from "path";
import { pdfToImg } from ".";
import { program, validatePrompts } from "./prompts";
import type { PageImage } from "./types";

program.parse(process.argv);

async function init() {
  try {
    const opts = validatePrompts(program.opts());

    console.log("Processing...");

    const images = await pdfToImg(opts.inputPath, {
      imgType: opts.imgType,
      returnType: "bytes",
      scale: opts.scale,
      pages: opts.pages,
      intent: opts.intent as "display" | "print" | "any",
      background: opts.background,
      documentOptions: {
        password: opts.password,
      },
      maxWidth: opts.maxWidth,
      maxHeight: opts.maxHeight,
      scaleForBrowserSupport: opts.scaleForBrowserSupport,
    });

    // A single-page selection ("firstPage", "lastPage", a number) comes back
    // as one image, not a list.
    const list: PageImage[] = Array.isArray(images) ? images : [images];

    list.forEach((img, index) => {
      const fileName = opts.nameTemplate
        .replace(/{i}/g, (index + 1).toString())
        .replace(/{p}/g, img.pageNumber.toString())
        .replace(/{ext}/g, opts.imgType);
      const filePath = path.join(opts.outputPath, fileName);
      fs.writeFileSync(filePath, img.bytes);
      console.log(`Saved: ${filePath}`);
    });
  } catch (error: any) {
    console.error(error.message);
  }
}

init();
