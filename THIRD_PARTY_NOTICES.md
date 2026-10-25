# Third-party notices

limenn's own code is licensed under the PolyForm Noncommercial License 1.0.0 (see [`LICENSE`](LICENSE)). The extension also contains the third-party components below. They remain under their own licenses, whose full texts are in [`licenses/`](licenses/). The noncommercial restriction does not apply to them.

## Models

| Component | Copyright / source | License |
| --- | --- | --- |
| Multilingual named-entity model (ONNX, 8-bit) | © David Adelani (Davlan), [Davlan/distilbert-base-multilingual-cased-ner-hrl](https://huggingface.co/Davlan/distilbert-base-multilingual-cased-ner-hrl); ONNX conversion by [Xenova](https://huggingface.co/Xenova/distilbert-base-multilingual-cased-ner-hrl). Built on DistilBERT © Hugging Face. | [Academic Free License 3.0](licenses/AFL-3.0.txt) |
| PII span model (`gliner-web-q8.onnx`) | © Urchade Zaratiana, [urchade/gliner_multi_pii-v1](https://huggingface.co/urchade/gliner_multi_pii-v1). **Modified by limenn:** exported to ONNX and compressed to 8 bits for use in the browser; the weights are otherwise unchanged. | [Apache License 2.0](licenses/Apache-2.0.txt) |
| Tokenizer for the PII span model | [onnx-community/gliner_multi_pii-v1](https://huggingface.co/onnx-community/gliner_multi_pii-v1) | [Apache License 2.0](licenses/Apache-2.0.txt) |
| Text recognition models (`tessdata_best`: deu, eng, fra, ita) | © Google and the Tesseract contributors, [tesseract-ocr/tessdata_best](https://github.com/tesseract-ocr/tessdata_best) | [Apache License 2.0](licenses/Apache-2.0.txt) |

## Libraries

| Component | Copyright | License |
| --- | --- | --- |
| transformers.js (`@huggingface/transformers`) | © Hugging Face | [Apache License 2.0](licenses/Apache-2.0.txt) |
| ONNX Runtime Web | © Microsoft Corporation | [MIT](licenses/MIT.txt) |
| pdf.js (`pdfjs-dist`) | © Mozilla Foundation | [Apache License 2.0](licenses/Apache-2.0.txt) |
| tesseract.js, tesseract.js-core | © Jerome Wu, Kevin Kwok, Guillermo Webster and contributors; Tesseract © Google | [Apache License 2.0](licenses/Apache-2.0.txt) |
| mammoth | © Michael Williamson | [BSD 2-Clause](licenses/BSD-2-Clause.txt) |
| JSZip | © Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso (used under its MIT option) | [MIT](licenses/MIT.txt) |

## Fonts

| Component | Copyright | License |
| --- | --- | --- |
| Inter Tight | © The Inter Project Authors | [SIL Open Font License 1.1](licenses/OFL-1.1.txt) |
| JetBrains Mono | © The JetBrains Mono Project Authors | [SIL Open Font License 1.1](licenses/OFL-1.1.txt) |

## Trademarks

ChatGPT is a trademark of OpenAI, Claude of Anthropic, Grok of xAI, and Chrome of Google. limenn is not affiliated with or endorsed by any of them; the names only describe what limenn works with.
