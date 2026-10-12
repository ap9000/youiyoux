import "./back.css";

/** Every screen has a back button: the phone's in its top bar, the desktop's beside the title. */
export function Screens() {
  return (
    <>
      <button type="button" className="so-phone-back">Back</button>
      <button type="button" className="so-phone-back">Back</button>
      <button type="button" className="so-phone-back">Back</button>
      <button type="button" className="so-back">Back</button>
    </>
  );
}
