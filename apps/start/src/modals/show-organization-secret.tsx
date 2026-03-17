import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ClipboardCopyIcon } from 'lucide-react';
import { toast } from 'sonner';

import { popModal } from '.';
import { ModalContent, ModalHeader } from './Modal/Container';

interface ShowOrganizationSecretProps {
  secret: string;
}

export default function ShowOrganizationSecret({
  secret,
}: ShowOrganizationSecretProps) {
  const copyToClipboard = () => {
    navigator.clipboard.writeText(secret);
    toast.success('Secret copied to clipboard');
  };

  return (
    <ModalContent>
      <ModalHeader
        title="Organization Secret"
        text="Copy this secret now. You won't be able to see it again."
      />
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Input value={secret} readOnly className="font-mono text-sm" />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={copyToClipboard}
          >
            <ClipboardCopyIcon className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Use this secret as the <code>openpanel-client-secret</code> header
          when sending events from server-side SDKs. It works with any project
          in this organization.
        </p>
        <Button onClick={() => popModal()} className="self-end">
          I've copied the secret
        </Button>
      </div>
    </ModalContent>
  );
}
