# Android Import Validation

Date: 2026-02-17T02:02:10.920Z

## Command Summary

- Command: `bun run test:epub-fixtures`
- Total fixtures: 3
- Passed fixtures: 3

## Extraction Report

| file | final_status | paragraphs | chapters | total_words | duration_ms | attempts | error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| plath-bell-jar.epub | completed | 2397 | 21 | 69757 | 159 | 1 | null |
| fitzgerald-great-gatsby.epub | completed | 1621 | 11 | 48176 | 62 | 1 | null |
| shelley-frankenstein.epub | completed | 691 | 29 | 74821 | 94 | 1 | null |

## State Transition Logs

- plath-bell-jar.epub: queued @ 1771293730560 -> validating @ 1771293730561 -> extracting_metadata @ 1771293730562 -> extracting_text @ 1771293730581 -> building_chapters @ 1771293730689 -> completed @ 1771293730697
- fitzgerald-great-gatsby.epub: queued @ 1771293730738 -> validating @ 1771293730739 -> extracting_metadata @ 1771293730739 -> extracting_text @ 1771293730741 -> building_chapters @ 1771293730794 -> completed @ 1771293730800
- shelley-frankenstein.epub: queued @ 1771293730812 -> validating @ 1771293730812 -> extracting_metadata @ 1771293730812 -> extracting_text @ 1771293730815 -> building_chapters @ 1771293730885 -> completed @ 1771293730892

## Known Limitations

- Decompression relies on `DecompressionStream`; very old browsers without this API are not supported.