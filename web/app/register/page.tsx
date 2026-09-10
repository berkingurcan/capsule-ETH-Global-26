import RegisterName from "@/components/RegisterName";

/* No server shell to speak of, and that is the point.

   Every other write page in this app takes the minter address as a prop from
   `loadServerEnv()`, because it talks to a Capsule contract. This one does not:
   it talks to ENS's `ETHRegistrar` and to an ERC-20, both of which are fixed
   addresses on a fixed chain. There is nothing to inject and nothing that can
   drift, so the page is a client component with a heading — and it keeps working
   if Capsule's own configuration is missing entirely, which is exactly the state
   somebody standing here for the first time may be in. */
export const metadata = {
  title: "Register a name · Capsule",
  description: "Register a .eth name on the ENSv2 Sepolia beta, and mint the test token to pay for it.",
};

export default async function RegisterPage({
  searchParams,
}: {
  /* `?label=` is where /connect sends someone whose name turned out not to exist,
     so the form opens on the name they already typed rather than making them
     type it twice. Only a default for the field — availability and price are
     re-read from the chain before anything can be signed. */
  searchParams: Promise<{ label?: string }>;
}) {
  const { label } = await searchParams;

  return (
    <div className="page wrap">
      <RegisterName initialLabel={label ?? ""} />
    </div>
  );
}
