<?php
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false]);
    exit;
}

require 'vendor/autoload.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

// Sanitise inputs
$first_name = htmlspecialchars(strip_tags(trim($_POST['first_name'] ?? '')));
$last_name  = htmlspecialchars(strip_tags(trim($_POST['last_name'] ?? '')));
$email      = filter_var(trim($_POST['email'] ?? ''), FILTER_SANITIZE_EMAIL);
$business   = htmlspecialchars(strip_tags(trim($_POST['business'] ?? '')));
$service    = htmlspecialchars(strip_tags(trim($_POST['service'] ?? '')));
$message    = htmlspecialchars(strip_tags(trim($_POST['message'] ?? '')));

if (empty($first_name) || empty($last_name) || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    echo json_encode(['success' => false]);
    exit;
}

$smtp_host = 'mail.adopt-it.ie';
$smtp_user = 'joe@adopt-it.ie';
$smtp_pass = '2126Therese1!';
$smtp_port = 587;

try {
    // Notification to Joe
    $mail = new PHPMailer(true);
    $mail->isSMTP();
    $mail->Host       = $smtp_host;
    $mail->SMTPAuth   = true;
    $mail->Username   = $smtp_user;
    $mail->Password   = $smtp_pass;
    $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
    $mail->Port       = $smtp_port;

    $mail->setFrom('joe@adopt-it.ie', 'Adopt IT Solutions');
    $mail->addAddress('joe@adopt-it.ie', 'Joe Murray');
    $mail->addReplyTo($email, "$first_name $last_name");

    $mail->Subject = "New Enquiry from $first_name $last_name — Adopt IT Solutions";
    $mail->Body    =
        "New enquiry from your website.\n\n" .
        "-------------------------------------------\n" .
        "Name:     $first_name $last_name\n" .
        "Email:    $email\n" .
        "Business: $business\n" .
        "Service:  $service\n" .
        "-------------------------------------------\n\n" .
        "Message:\n$message\n\n" .
        "Sent from adopt-it.ie\n";

    $mail->send();

    // Auto-reply to enquirer
    $reply = new PHPMailer(true);
    $reply->isSMTP();
    $reply->Host       = $smtp_host;
    $reply->SMTPAuth   = true;
    $reply->Username   = $smtp_user;
    $reply->Password   = $smtp_pass;
    $reply->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
    $reply->Port       = $smtp_port;

    $reply->setFrom('joe@adopt-it.ie', 'Joe Murray — Adopt IT Solutions');
    $reply->addAddress($email, "$first_name $last_name");

    $reply->Subject = "Thanks for getting in touch — Adopt IT Solutions";
    $reply->Body    =
        "Hi $first_name,\n\n" .
        "Thanks for reaching out to Adopt IT Solutions.\n\n" .
        "I've received your message and will get back to you within one business day.\n\n" .
        "Best regards,\n" .
        "Joe Murray\n" .
        "Founder, Adopt IT Solutions\n" .
        "joe@adopt-it.ie\n" .
        "adopt-it.ie\n";

    $reply->send();

    echo json_encode(['success' => true]);

} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
?>
