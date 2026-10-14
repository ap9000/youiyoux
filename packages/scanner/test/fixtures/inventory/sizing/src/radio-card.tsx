export function RadioCard() {
  return <div className="flex h-11 gap-2">
    <button type="button" role="radio" aria-checked="false" aria-label="Choose plan" className="size-4 shrink-0 rounded-full border" data-sizing="radio"><svg aria-hidden="true" className="size-2" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /></svg></button>
    <span>Plan</span>
    <span className="block size-6 shrink-0 rounded-full border" data-sizing="badge" />
    <span className="block w-5 h-5 shrink-0 border" data-sizing="icon" />
  </div>;
}
