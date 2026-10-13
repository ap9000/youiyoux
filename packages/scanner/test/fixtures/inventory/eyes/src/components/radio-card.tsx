import { useRadioGroup } from "./radio-group";
export function RadioCard({ id, title }: { id: string; title: string }) {
  useRadioGroup();
  return <div className="bg-white text-black p-4">
    <input type="radio" name="plan" id={id} /><label htmlFor={id}>{title}</label>
    <button type="button"><svg aria-hidden="true" width="20" height="20" /></button>
    <span className="text-black">Details</span>
  </div>;
}
