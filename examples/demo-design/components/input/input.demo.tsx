/** Hub preview for Input: empty, filled, invalid and disabled. */
import { Input } from "./input";

const label = "text-label text-foreground";

export default function InputDemo() {
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="demo-email" className={label}>
          Email
        </label>
        <Input id="demo-email" type="email" placeholder="ada@example.com" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="demo-name" className={label}>
          Project name
        </label>
        <Input id="demo-name" defaultValue="Atlas" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="demo-slug" className={label}>
          Address
        </label>
        <Input id="demo-slug" invalid defaultValue="atlas!" aria-describedby="demo-slug-error" />
        <p id="demo-slug-error" className="text-label text-danger">
          Use letters, numbers and dashes.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="demo-locked" className={label}>
          Owner
        </label>
        <Input id="demo-locked" disabled defaultValue="Managed by your admin" />
      </div>
    </div>
  );
}
