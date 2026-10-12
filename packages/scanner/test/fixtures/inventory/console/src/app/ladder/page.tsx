/**
 * Six hand-rolled buttons, 2px apart from 28px to 38px. Each step is within tolerance of the
 * next, so single-link clustering would chain all six (and the kit's 32px button) into one
 * family; complete-link keeps 28px and 38px apart.
 */
export default function LadderPage() {
  return (
    <div className="flex gap-2 p-8">
      <button className="inline-flex h-7 items-center rounded-md px-3 text-sm font-medium">28</button>
      <button className="inline-flex h-[30px] items-center rounded-md px-3 text-sm font-medium">30</button>
      <button className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium">32</button>
      <button className="inline-flex h-[34px] items-center rounded-md px-3 text-sm font-medium">34</button>
      <button className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium md:h-10">36</button>
      <button className="inline-flex h-[38px] items-center rounded-md px-3 text-sm font-medium">38</button>
    </div>
  );
}
