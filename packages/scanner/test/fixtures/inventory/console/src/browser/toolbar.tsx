import "./ui.css";

/** The browser pane's toolbar: the same 32px button as the CVA Button, from the CSS kit. */
export function BrowserToolbar() {
  return (
    <div className="flex gap-2">
      <input className="ui-input" name="url" />
      <button className="ui-button">Go</button>
    </div>
  );
}
