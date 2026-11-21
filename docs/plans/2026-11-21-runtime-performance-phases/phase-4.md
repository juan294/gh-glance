# Phase 4 · Shared acquisition and encoding

Start from accepted phase 3. The changes below remove repeated work in existing local transactions, projections and senders. Keep one implementation owner because all touch the executable. Measure each saving independently.

## Disk publication

Pass a transaction-local preparation function from the disk transaction to its operation and writer. For publication, retain at most the candidate's prepared payload and descriptor, keyed by its finalized query key and exact immutable snapshot object. Trim may inspect several records. For other inline records, keep the existing preparation behavior and avoid retaining all their payloads. The disk writer visits only the records that actually survived trim. Reuse a prepared result only on an exact match. Preparation must follow alias remapping and final lastChangedAt assignment, and must end with the transaction. Preserve the public/injected storage contract that can execute an operation with the state alone. A default preparation argument suffices on that path. See `index.mjs:14856`, `index.mjs:15093`, `index.mjs:15137`, `index.mjs:15198`, `index.mjs:15259`, `index.mjs:15556`, `index.mjs:15587`, `index.mjs:15605`.

```
@ publish under the existing store lock -> verified snapshot descriptor
pre: claim current and candidate normalized under its final query key
do:
  1. compute candidate bytes, digest and descriptor when trim first needs them
  2. validate capacity against retained records
  3. lookup the prepared candidate only for the matching final key and snapshot
  4. write retained artifacts and then replace metadata using the current writer
fail: capacity or write failure -> preserve the previous readable generation and existing retry path
```

Preserve both passes through the stored-row normalizer. The content digest hashes first-pass rows, while the comparison string normalizes them again. A title of 299 letters followed by a space and one more letter demonstrates the difference. The first pass clips after the space and the second trims that now-trailing space. Reusing the first-pass array would change the comparison identity for existing data. The transaction can still reuse the exact serialized artifact safely. Cover this input in the byte-parity test. See `index.mjs:319`, `index.mjs:2621`, `index.mjs:14162`, `index.mjs:14798`, `index.mjs:14817`.

## Quota display

Pass the already successful governor inspection from bootstrap/control to the diagnostic projection. Carry its originating scope alongside it and use it only for the same scope hash and access partition in that immediate call. At the projection's current clock time, calculate reservation units exactly as today. Preserve the existing one-argument public method, fresh-read fallback on absent/mismatched evidence, unavailable status on its read failure, monotonically ordered revisions and access cleanup. The mounted wrapper currently skips an unsuccessful observation. Keep that behavior. Admission, lease and observer callers retain their authoritative reads. See `index.mjs:7017`, `index.mjs:15959`, `index.mjs:15996`, `index.mjs:20978`, `index.mjs:22788`, `index.mjs:22898`.

## Collector frames and short strings

Compute UTF-8 payload size from JSON to enforce the existing assembly limit. Keep prepared snapshot and JSON available immediately, and make its payload Buffer available through a memoized lazy access on the same prepared object. Both frame iterators must delay reading the payload until the **whole encoded single-frame envelope including newline** exceeds its byte limit. Share a chunked payload across simultaneous line senders via the existing encoding cache. Keep protocol frame/assembly/chunk limits, digest, chunk layout, reference release and sender backpressure. See `index.mjs:7824`, `index.mjs:9525`, `index.mjs:9534`, `index.mjs:9573`, `index.mjs:9596`, `index.mjs:9844`.

In `safe`, after the existing conversion, control removal and trim, return a cleaned string with length at most 300 UTF-16 code units immediately. Above that threshold use the current code-point clamp. A short UTF-16 length proves the code-point count fits. The converse is false for astral characters. See `index.mjs:309`, `index.mjs:319`, `index.mjs:14098`.

## Consumer sweep

- Run `rg -n 'prepareAcquisitionSnapshot|writeAcquisitionStore|withAcquisitionStore|trimAcquisitionStore|acquisitionContentRaw|normalizeAcquisitionSnapshot' index.mjs test scripts`. Cover transactional disk write and trim above, subscription/canonical remap at `index.mjs:15405` and `index.mjs:15465`, publication rollback at `index.mjs:15605`, metadata-only records and old inline snapshots, staging/removal at `index.mjs:15067` and `index.mjs:15128`, and the injected storage adapter at `index.mjs:15259`. Both fetcher and stored snapshot must produce the same comparison raw. Preserve reader digest verification at `index.mjs:15017`.
- Run `rg -n 'syncQuotaProjection|syncRuntimeQuotaProjection' index.mjs test scripts`. Both mounted calls are above. Exercise the one-argument uses at `test/acquisition.test.mjs:912`, `test/acquisition.test.mjs:1464`, `test/acquisition.test.mjs:1791`, `scripts/measure-efficiency.mjs:1180`. Preserve hold, scope revocation and display recovery.
- Run `rg -n 'prepareCollectorSnapshot|createCollectorSnapshotEncodingCache|collectorSnapshot(Line|Frame)Iterator|encodeCollectorSnapshotFrames|safe\(' index.mjs test scripts`. Cover the sender at `index.mjs:9844`, object/array encoder at `index.mjs:9622`, assembler at `index.mjs:9626`, reconnect at `index.mjs:11190`, protocol tests at `test/collector-protocol.test.mjs:89` and App-provider decoding at `test/app-auth.test.mjs:617`. All field-normalizer consumers continue to receive identical strings, including persisted rows, renderer input and diagnostics. Representative call and output oracles are `index.mjs:14098`, `test/unit.test.mjs:174` and `test/unit.test.mjs:2589`.

## Automated acceptance and recovery

1. Count the actual artifact serializer/hash calls on a disk-backed publish from capacity check through file replacement. Require one preparation of the published candidate and equal artifact bytes, filename/digest, metadata and verified reread against baseline. Include the clipping-and-trimming case above in stored raw and content-digest comparisons. Exercise injected storage, unchanged generations, alias remap, older inline forms, evictions, capacity refusal followed by a successful smaller publication, and write failure followed by a successful retry. Check two transactions cannot reuse each other's payload. See `test/acquisition.test.mjs:71`, `test/acquisition.test.mjs:197`, `test/acquisition.test.mjs:363`, `test/acquisition.test.mjs:2141`, `test/acquisition.test.mjs:2201`, `test/acquisition.test.mjs:2314`.
2. Count successful bootstrap/control diagnostic projections with and without the supplied inspection. Each supplied same-scope success saves one synchronous governor lock/read. Compare projected revision, units, status, access keys and timestamp using the same clock. Verify authorized visibility. See `index.mjs:16007`. Cover older/newer revisions out of order, mismatched scope, failed standalone read then recovery, expired reservations and revoked access. Existing admission/refusal cases must still consult the governor. See `test/acquisition.test.mjs:936` and `test/acquisition.test.mjs:1464`.
3. Count payload Buffer creations for the production line sender and the object iterator. Require zero for a small frame and one shared payload for overlapping chunked line sends of the same prepared input. Exercise the outgoing single-frame byte boundary with realistic multibyte content. Test the declared assembly byte limit just below, at and above its cutoff via incoming snapshot-begin frames at `index.mjs:9659`. Use valid chunks for end-to-end reconstruction. Verify framing, digest, assembled output, stalled drain/release, malformed partial transfer and recovery on reconnect. See `test/collector-protocol.test.mjs:102`, `test/collector-protocol.test.mjs:130`, `test/collector-protocol.test.mjs:158`, `test/collector-protocol.test.mjs:233`, `test/collector-protocol.test.mjs:378`.
4. Differentially compare the old and proposed normalizers on empty, coerced, control, bidi and Unicode inputs. Include 299 ASCII characters plus one astral character, 300 ASCII plus one astral character, and long all-astral strings. Verify short cleaned inputs skip the code-point array. Reuse `test/unit.test.mjs:198`, `test/unit.test.mjs:208`, `test/unit.test.mjs:2608`.
5. Run focused tests followed by the [main plan](../2026-11-21-runtime-performance.md)'s sequential lint, syntax, unit, efficiency and PTY commands.

**Manual acceptance.** No manual operation required. Report preparation and allocation counts, output equality and a successful read after each induced recoverable failure. Whole-process RSS is a separate measurement.
