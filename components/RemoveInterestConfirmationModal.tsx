"use client";

export function RemoveInterestConfirmationModal({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-zinc-950/35 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-soft">
        <h2 className="text-xl font-bold text-zinc-950">Are you sure you want to remove interest?</h2>
        <div className="mt-5 flex justify-center gap-3">
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
          >
            Yes
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
