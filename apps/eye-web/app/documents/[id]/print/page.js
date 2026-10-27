import { DocumentPrint } from "../../../../components/document-editor";

export default async function DocumentPrintPage({ params }) {
  const { id } = await params;
  return <DocumentPrint documentId={id} />;
}
