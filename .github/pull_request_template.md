## Summary

-

## Validation

- [ ] `npm run test:aurora:unit`
- [ ] `npx vue-tsc -b --pretty false`
- [ ] `npm run build`
- [ ] `npm run test:aurora` or manual Aurora browser smoke, when UI/routing/security changed

## Aurora OS Integration Checklist

Use `docs/aurora-validation.md` as the source of truth for detailed validation.

- [ ] Aurora-facing capabilities are registered in `capability-manifest.ts` when they should appear in the coverage matrix.
- [ ] Tool definitions use the correct L1-L4 security level.
- [ ] Natural-language routing is isolated in `intent-parsers.ts` and covered by parser tests.
- [ ] Structured legacy output renders through ResultOverlay presenters or App Mode, not raw JSON.
- [ ] Heavy legacy apps open through App Mode without revealing the Advanced Console.
- [ ] Hub/Proxy remains excluded from Aurora App Mode.
- [ ] L3/L4 actions require approval and cannot bypass Governance or Approval Gateway.
- [ ] Unknown Aurora prompts fall back to the standard Hermes chat stream.
- [ ] Legacy Hermes routes, backend APIs, and Socket.IO streaming remain intact.

## UI Evidence

Add screenshots or recordings for visible Aurora/Hermes UI changes:

- Idle launcher:
- Active chat:
- App Mode or overlay:

## Notes

-
