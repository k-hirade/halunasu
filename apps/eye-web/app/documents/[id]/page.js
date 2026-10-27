import { DocumentEditor } from "../../../components/document-editor";

export default async function DocumentPage({ params }) {
  const { id } = await params;
  return <DocumentEditor documentId={id} />;
}
