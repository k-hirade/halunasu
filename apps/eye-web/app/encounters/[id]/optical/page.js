import { OpticalPrint } from "../../../../components/optical-print";

export default async function OpticalPrintPage({ params }) {
  const { id } = await params;
  return <OpticalPrint encounterId={id} />;
}
