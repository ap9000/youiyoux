import { Button } from "@/components/ui";
export function CheckoutForm({ cta, rest }: { cta: string; rest: Record<string, unknown> }) {
  return <form>
    <Button variant={cta} {...rest}>Pay</Button>
  </form>;
}
