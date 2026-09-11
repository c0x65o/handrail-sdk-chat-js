// The database/runtime must exist before starting an expensive Flutter child.
// Still pass a readiness promise to the host so Flutter requests wait for build.
export async function startChatLabWithFlutter(startLab, buildFlutter) {
  let resolveFlutter;
  let rejectFlutter;
  const flutterReady = new Promise((resolve, reject) => {
    resolveFlutter = resolve;
    rejectFlutter = reject;
  });
  void flutterReady.catch(() => {});
  const lab = await startLab({ flutterReady });
  void Promise.resolve().then(buildFlutter).then(resolveFlutter, rejectFlutter);
  return { lab, flutterReady };
}
